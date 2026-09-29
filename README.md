# l2_crypto — CPU-based Layer-2 VPN appliance

Goal: secure, standards-based Ethernet encryption (IEEE 802.1AE MACsec + MKA)
between two appliances directly connected by a dedicated fiber, bridging two
LANs, with crypto on the CPU and a target of ≥ 10 Gbit/s, built on Linux and
mature existing implementations.

## Status

| Phase | Topic | State |
|-------|-------|-------|
| 1 | Requirements, threat model, architecture, hardware options | **Draft v0.2 (MACsec) — awaiting answers to open questions** |
| 2 | Hardware selection (BOM with part numbers) | not started |
| 3 | Basic L2 bridge `LAN ↔ Linux ↔ WAN` | not started |
| 4 | VPN integration | not started |
| 5 | Security hardening | not started |
| 6 | Performance validation | not started |

## Documents

- [Phase 1 — Requirements, threat model and architecture](docs/phase1-architecture.md)
