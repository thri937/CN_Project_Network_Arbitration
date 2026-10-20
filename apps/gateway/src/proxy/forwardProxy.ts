import http, { IncomingMessage, ServerResponse } from 'node:http';
import net from 'node:net';
import { DeviceRegistry } from '../sessions/deviceRegistry.js';
import { ShaperScheduler } from '../shaper/scheduler.js';

export interface ForwardProxyOptions {
  port: number;
  enabled: boolean;
  deviceRegistry: DeviceRegistry;
  scheduler: ShaperScheduler;
}

export class ForwardProxyServer {
  private port: number;
  private enabled: boolean;
  private deviceRegistry: DeviceRegistry;
  private scheduler: ShaperScheduler;
  private server?: http.Server;

  constructor(opts: ForwardProxyOptions) {
    this.port = opts.port;
    this.enabled = opts.enabled;
    this.deviceRegistry = opts.deviceRegistry;
    this.scheduler = opts.scheduler;
  }

  public async start(): Promise<void> {
    if (!this.enabled) return;

    return new Promise((resolve) => {
      this.server = http.createServer((req, res) => {
        this.handleHttp(req, res);
      });

      this.server.on('connect', (req, clientSocket, head) => {
        this.handleConnect(req, clientSocket as net.Socket, head);
      });

      this.server.listen(this.port, '0.0.0.0', () => {
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    if (!this.server) return;
    return new Promise((resolve) => {
      this.server?.close(() => resolve());
    });
  }

  private getClientIp(socket: net.Socket): string {
    const raw = socket.remoteAddress || '127.0.0.1';
    return raw.replace(/^::ffff:/, '');
  }

  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const ip = this.getClientIp(req.socket as net.Socket);
    const dev = this.deviceRegistry.getDeviceByIp(ip);

    if (!dev) {
      res.statusCode = 403;
      res.setHeader('Content-Type', 'text/html');
      res.end(`<html><body><h3>Access Denied</h3><p>Join a slice first at <a href="http://192.168.137.1:8080/join">http://192.168.137.1:8080/join</a></p></body></html>`);
      return;
    }

    // Forward HTTP request
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || 80,
      path: url.pathname + url.search,
      method: req.method,
      headers: req.headers,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', () => {
      res.statusCode = 502;
      res.end('Bad Gateway');
    });

    req.pipe(proxyReq);
  }

  private handleConnect(req: IncomingMessage, clientSocket: net.Socket, head: Buffer): void {
    const ip = this.getClientIp(clientSocket);
    const dev = this.deviceRegistry.getDeviceByIp(ip);

    if (!dev) {
      clientSocket.write('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\n\r\nJoin a slice first at http://192.168.137.1:8080/join\r\n');
      clientSocket.end();
      return;
    }

    const [host, portStr] = (req.url || '').split(':');
    const port = parseInt(portStr || '443', 10);

    const targetSocket = net.connect(port, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length > 0) {
        targetSocket.write(head);
      }
      clientSocket.pipe(targetSocket);
      targetSocket.pipe(clientSocket);
    });

    targetSocket.on('error', () => {
      clientSocket.destroy();
    });

    clientSocket.on('error', () => {
      targetSocket.destroy();
    });
  }
}
