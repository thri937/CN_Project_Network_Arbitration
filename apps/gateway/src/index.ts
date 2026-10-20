export function startGateway() {
  console.log('Slice Gateway initialized');
}

if (process.env.NODE_ENV !== 'test') {
  startGateway();
}
