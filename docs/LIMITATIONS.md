# Limitations and Emulation Boundaries — CN Real Network Arbitration

In compliance with §2 and Ground Rule 3 of the project specification, this document provides an honest, transparent breakdown of what is **physically real** versus what is **emulated or approximated** in this testbed.

---

## 1. What Is "Real" in This System

1. **Physical Wi-Fi & TCP Connections:**
   - Client devices (smartphones, laptops) establish genuine IEEE 802.11 Wi-Fi associations with the Windows 11 laptop's Mobile Hotspot.
   - All load traffic, probe requests, and WebSocket messages traverse physical network interface cards (NICs), wireless radio frequencies, and the operating system network stack.
2. **Byte-Accurate Traffic Shaping:**
   - The slice gateway rate limiter actually meters, queues, and tail-drops packets to enforce both the per-slice rate limits and the 950 kbps shared bottleneck link.
   - Slices cannot transmit faster than their assigned limits.
3. **Empirical Telemetry Measurements:**
   - Throughput, queueing delay, latency, jitter (RFC 3550), packet loss, and service availability are calculated strictly from real measured packets and probe RTTs.
   - No numbers are synthesized or manufactured. When a slice has no active devices sending probes, metrics explicitly report `null` / `UNKNOWN`.
4. **Dynamic Closed-Loop Arbitration:**
   - Contention triggers the real CBHA solver. The resulting limits are pushed via REST and immediately reconfigure the live data-plane token buckets.

---

## 2. What Is Emulated or Approximated

### 2.1 Application-Layer UPF vs. 3GPP Radio Slicing
In a commercial 5G Standalone (SA) network, slicing is enforced across three distinct domains:
1. **Radio Access Network (RAN):** The gNodeB allocates dedicated Physical Resource Blocks (PRBs) or priority-weighted scheduling over the licensed 5G NR air interface.
2. **Transport Network (TN):** Segment routing, MPLS-TE, or FlexE partitions the backhaul links.
3. **Core Network (5GC):** The User Plane Function (UPF) enforces per-session and per-flow QoS profiles.

**In this testbed:**
- Slicing is enforced at the **Application-Layer Gateway**, which functions analogously to a **slice-aware UPF / SD-WAN edge**.
- The physical Wi-Fi medium (802.11 CSMA/CA) is **shared**. The radio airtime itself is not partitioned into dedicated radio channels. Heavy interference or collisions at the RF layer can introduce physical wireless jitter that is external to the gateway's token bucket queues.

---

### 2.2 Bottleneck Link Emulation
- The physical Wi-Fi link between phone and laptop typically supports 54 Mbps to 433 Mbps, and the upstream ISP connection is typically 50–500 Mbps.
- The **1 Mbps bottleneck** is a software constraint enforced by the gateway's root token bucket (`offeredKbps = 950`).
- If the upstream ISP connection degrades below 1 Mbps (detected via `npm run isp:check`), the external ISP becomes the bottleneck rather than the testbed shaper.

---

### 2.3 Forward Proxy Demand Estimation Heuristics
When client devices route traffic through the HTTP forward proxy (`:8888`):
- Unlike synthetic load sessions (where the client explicitly requests a target rate like 280 kbps), real web browsing applications (video streaming, file downloads) generate variable demand governed by TCP congestion control (BBR / CUBIC).
- The gateway estimates proxy demand from the measured upstream read rate. If the proxy backlog buffer remains more than $50\%$ full during a sampling window, the gateway marks the slice as saturated and estimates demand as $\max(\text{read rate}, 1.1 \times \text{limit})$.

---

### 2.4 User-Space Scheduling vs. Kernel Traffic Control
- The gateway runs in user-space Node.js on Windows 11.
- Although high-resolution monotonic timestamps (`process.hrtime.bigint()`) eliminate rate drift caused by Windows 15.6 ms timer jitter, user-space execution is subject to OS process scheduling priorities and garbage collection pauses.
- For microsecond-accurate L3/L4 packet scheduling, an operating system kernel packet scheduler (such as Linux `tc-htb` or eBPF XDP) would be used. An optional Linux `tc` adapter specification is defined in §18 Phase 8 for environments running Linux.

---

### 2.5 Single-Laptop Loopback Mode
- When running `npm run demo:local` or testing in single-laptop mode, traffic traverses the `127.0.0.1` loopback interface.
- Loopback eliminates physical wireless RF multipath, packet corruption, and distance attenuation. However, the data plane shaping, token bucket policing, queueing delay, and CBHA arbitration invariants are tested identically.
