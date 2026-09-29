# Phase 1 — Requirements, Threat Model and Architecture

Status: **DRAFT for review** — nothing here is committed until the open
questions in §14 are answered. No implementation code is written in this phase.

Conventions used in this document:

- **[DECISION]** — a recommendation that needs your confirmation.
- **[VERIFY]** — a fact, version number, or price that must be checked against
  current vendor documentation / measurement before we rely on it.
- **[ESTIMATE]** — a planning number, not a measurement. Phase 6 replaces these
  with measured values.

---

## 1. Requirements summary

### 1.1 Functional

| ID | Requirement |
|----|-------------|
| F1 | Transport Ethernet frames (Layer 2) between two LANs over an IP WAN. |
| F2 | Each appliance has a LAN port and a WAN port (plus, proposed, a separate management port — see Q6). |
| F3 | Transparent for IPv4, IPv6, ARP, ND, DHCP and other EtherTypes that policy allows. |
| F4 | 802.1Q VLAN-tagged traffic supported with an explicit VLAN allowlist. |
| F5 | Configurable policy for broadcast, multicast, unknown unicast, link-local control frames (STP/LLDP/LACP/802.1X). |
| F6 | Frames up to the configured LAN MTU are carried **without silent loss** (bridges cannot send ICMP "too big"). |
| F7 | Tunnel is encrypted, integrity-protected, mutually authenticated and replay-protected. |

### 1.2 Non-functional (in priority order, as you specified)

1. **Security** — standard protocols, mature implementations, minimal custom code, least privilege.
2. **Correct L2 behaviour** — including honest documentation of what is filtered.
3. **≥ 10 Gbit/s** — exact definition is open (Q2). This document shows that
   *64-byte line rate over a 10 GbE WAN is physically impossible* regardless of
   CPU (§11.1), so the target needs precise wording.
4. **Reasonable complexity**, 5. **Maintainability**, 6. **Cost**.

### 1.3 Constraints

- Crypto on the CPU (no NIC inline-IPsec / MACsec offload, no QAT).
- Linux preferred; C for any custom low-level code.
- No home-grown crypto or VPN protocol.

### 1.4 Explicit non-goals (proposed)

- Not a router, firewall for LAN hosts, or IDS.
- No multipoint/mesh in v1 (point-to-point only) unless Q3 says otherwise.
- No protection *between LAN hosts* beyond the L2 policy in §9 — an L2 VPN
  deliberately merges two broadcast domains.

---

## 2. Threat model

### 2.1 Protected assets

| Asset | Why it matters |
|-------|----------------|
| A1 Confidentiality of LAN frames on the WAN | Primary purpose of encryption. |
| A2 Integrity/authenticity of frames entering a LAN from the tunnel | Injection into a LAN = full L2 access to that site. |
| A3 Long-term authentication keys (IKE private key / WireGuard static key) | Compromise ⇒ impersonation of an appliance. |
| A4 Session keys (ESP SA keys) | Compromise ⇒ decryption of that SA's traffic. |
| A5 Appliance configuration (peer identity, trust anchors, L2 policy) | Tampering ⇒ silent redirection or policy bypass. |
| A6 Availability of the L2 link | A site-to-site L2 extension is often infrastructure-critical. |
| A7 Management credentials | Admin access ⇒ everything above. |

### 2.2 Trust boundaries

```text
     LAN A (semi-trusted)          WAN (untrusted)          LAN B (semi-trusted)
 ┌──────────────┐  TB1  ┌──────────────┐ TB2 ┌──────────────┐ TB1' ┌──────────────┐
 │ hosts, switch│◄─────►│ Appliance A  │◄───►│ Appliance B  │◄────►│ hosts, switch│
 └──────────────┘       └──────┬───────┘     └──────┬───────┘      └──────────────┘
                               │ TB3 (mgmt)         │ TB3
                          management net       management net
```

- **TB1 LAN↔appliance**: LAN hosts may be malicious. They can send any frame.
- **TB2 WAN↔appliance**: fully untrusted. Only IKE + ESP from the configured peer is accepted.
- **TB3 management**: trusted operators only, separate interface.
- **Peer appliance**: trusted for authentication, but *a compromised peer
  = full L2 access to our LAN*. Crypto cannot prevent that.
- **Inside the appliance**: kernel + IKE daemon are the trusted computing base
  (TCB). Everything else runs unprivileged.

### 2.3 Security assumptions

1. The Linux kernel, strongSwan (or WireGuard) and OpenSSL/kernel crypto are
   correct enough; we track their security updates.
2. Hardware/firmware (CPU, NIC firmware, BMC) are not malicious. BMC is disabled
   or isolated.
3. Private keys are generated on the appliance and never leave it (TPM-backed in production).
4. Clocks are roughly correct (needed for certificate validity; not for ESP).
5. The operators and the management network are trusted.

### 2.4 Attack surfaces

| Surface | Exposed to | Code handling it |
|---------|-----------|------------------|
| WAN: IKE (UDP 500/4500) | Internet | strongSwan charon (user space, C) |
| WAN: ESP (IP proto 50) / ESP-in-UDP | Internet | kernel XFRM (pre-auth: SPI lookup + AEAD verify only) |
| WAN: everything else | Internet | nftables netdev ingress → drop |
| LAN: every Ethernet frame | LAN hosts | NIC, kernel bridge, nftables bridge family |
| Tunnel (post-decrypt) frames | peer site's hosts | kernel GRE decap, bridge, nftables |
| Management port | admin network | sshd (+ future CLI) |
| Physical / console / BMC | local attacker | firmware, bootloader |
| Supply chain | — | distro packages, NIC firmware |

### 2.5 Threat analysis

| Threat | Mitigation | Residual risk / limitation |
|--------|-----------|----------------------------|
| Eavesdropping on WAN | ESP AES-256-GCM | Traffic analysis (below). |
| Packet injection/modification on WAN | ESP AEAD ICV; **inbound XFRM policy requiring ESP for GRE** + nftables `meta ipsec exists` check on GRE | Misconfiguration that lets plaintext GRE through ⇒ unauthenticated injection into LAN. This is *the* critical config invariant; must be tested (Phase 5). |
| Replay | ESP sequence numbers + anti-replay window, ESN enabled | Replay window tuned for per-CPU SAs / reordering. |
| Traffic analysis | none by default | Frame sizes, timing, volume and inner VLAN activity are visible as ESP sizes/timing. Padding/constant-rate is out of scope (would destroy throughput). **Not claimed.** |
| Peer impersonation | IKEv2 mutual cert (or raw public key) auth, pinned peer identity | Relies on key secrecy. |
| Long-term key compromise | PFS (ECDHE, optional ML-KEM hybrid) protects past sessions; revocation §10 | Active impersonation possible until revoked. |
| Harvest-now-decrypt-later (quantum) | Optional IKEv2 hybrid ML-KEM (RFC 9370) [VERIFY strongSwan version] | Auth still classical (acceptable: only matters for real-time attack). |
| Compromised remote appliance | L2 policy (§9) limits frame classes; MAC limit; rate limits | **Attacker gets L2 adjacency to our LAN** (ARP/ND spoofing, DHCP spoofing, scanning). Fundamental to L2 VPN. |
| Compromised local appliance | Secure boot, read-only rootfs, TPM keys (prod) | Game over for both LANs' traffic through it. |
| Malicious LAN host: MAC flooding | bridge `fdb_max_learned` (bridge-wide) [VERIFY kernel ≥ 6.x], ageing | CAM exhaustion on *remote* switches still possible within rate limit. |
| Malicious LAN host: broadcast/multicast storm | per-class rate limits before the tunnel (§9) | Legit bursts may be dropped if limits too tight. |
| ARP/ND spoofing across sites | Not prevented by default (optional static inspection later) | Same as on any flat L2 network. |
| Rogue DHCP / RA across sites | Optional per-site DHCP/RA blocking (§9) | Site-specific decision (Q4). |
| VLAN hopping / double tagging | VLAN allowlist on bridge; drop 0x88a8 and nested tags unless enabled | Native-VLAN mistakes on customer switches are outside our control. |
| STP/BPDU attacks, root-bridge takeover across sites | BPDUs dropped by default at tunnel; log/alarm on BPDU arrival | Loops through other paths not detected by us ⇒ storm control is the backstop. |
| Malformed frames/tunnel packets | Kernel parsers only (no custom parsers in data plane); NIC drops bad FCS/runts | Kernel bugs — track updates. |
| DoS on WAN (flood to WAN IP) | nftables netdev ingress early drop; IKE cookies/rate limits (strongSwan); XDP drop only if measured necessary | Link saturation upstream cannot be mitigated by the appliance. |
| DoS via IKE (half-open SA exhaustion) | IKEv2 cookies, `init_limit_half_open`, only one peer configured | — |
| DoS via ESP garbage | SPI lookup fails fast; AEAD verify cost bounded | CPU cost per garbage packet ≈ one lookup (+ one AEAD verify if SPI guessed). |
| Management-plane attack | Separate mgmt port, nothing listening on LAN/WAN, SSH keys only, no web UI in v1 | — |
| Config compromise | Root-only config, signed/validated configs, audit log | — |
| Supply chain | Distro packages only, pinned versions, reproducible image (prod) | — |

### 2.6 What this system does **not** provide (stated explicitly)

- No protection from hosts at the other site: it *is* the same L2 segment.
- No traffic-flow confidentiality (sizes/timing visible).
- No availability guarantee against upstream WAN flooding.
- No protection if either appliance is compromised.
- Encryption covers the WAN only; frames are plaintext on both LANs.

---

## 3. Layer-2 data flow

### 3.1 Outbound (LAN A → WAN) — recommended stack (§4)

```text
LAN wire
  │ frame (≤ LAN MTU + 14/18/22)
  ▼
NIC lan0: FCS check, RSS on inner L3/L4 hash → N RX queues → N CPUs
  ▼
[nftables bridge ingress] ethertype/VLAN/BPDU policy, bcast/mcast rate limit
  ▼
Linux bridge br0: VLAN filter, FDB learn src MAC, lookup dst MAC
  ├─ dst learned on lan0 → drop (local traffic, never crosses WAN)
  └─ dst learned on gre0 / unknown / bcast / mcast → forward to gre0
  ▼
gretap gre0: + GRE hdr (4) + outer IPv4 (20), proto 47, src=WAN_A dst=WAN_B
  ▼
XFRM output (transport mode, per-CPU SA): ESP AES-256-GCM encrypt on the *same CPU*
  ▼
NIC wan0 TX (checksum/TSO offloads where applicable)
  ▼
WAN
```

### 3.2 Inbound (WAN → LAN A)

```text
WAN
  ▼
NIC wan0 RX — RSS hash of outer IP pair + proto 50 → ⚠ likely ONE queue (see §11.4)
  ▼
[nftables netdev ingress]: allow ESP/IKE from peer, ICMP PTB from peer, drop rest
  ▼
XFRM input: SPI lookup → anti-replay check → AES-GCM decrypt/verify
  ▼
GRE decap (policy check: GRE MUST have arrived via ESP, else drop)
  ▼
gretap gre0 → bridge br0: learn src MAC on gre0, forward to lan0
  ▼
[nftables bridge] policy for tunnel→LAN direction
  ▼
NIC lan0 TX → LAN wire
```

### 3.3 Where each L2 function lives

| Function | NIC hardware | Linux kernel | User space | VPN software |
|----------|-------------|--------------|------------|--------------|
| FCS, runt/giant drop | ✔ | | | |
| RSS / queue steering | ✔ (config via ethtool) | | config | |
| Promiscuous RX | ✔ | bridge sets it | | |
| MAC learning / FDB | | ✔ bridge | | |
| Flooding bcast/mcast/unknown | | ✔ bridge | | |
| VLAN filtering | (optional HW VLAN filter off for transparency) | ✔ bridge `vlan_filtering` | | |
| IGMP/MLD snooping | | ✔ bridge (evaluate) | | |
| Ethertype / BPDU / MAC filters, rate limits | | ✔ nftables bridge family / tc | config | |
| L2 encapsulation | | ✔ gretap | | |
| Encryption, replay | | ✔ XFRM (ESP) | | |
| Key exchange, auth, rekey | | | | ✔ strongSwan charon (IKEv2) |
| Config generation/validation | | | ✔ small tool | |
| STP | | off (see §9.5) | | |

The custom-code footprint in the data plane is **zero**. That is intentional.

---

## 4. Proposed architecture

### 4.1 Recommendation [DECISION]

> **Linux kernel data plane: `lan0` + `gretap` in a Linux bridge, GRE protected by
> IPsec ESP (AES-256-GCM, transport mode, route- or policy-based XFRM),
> keyed by IKEv2 (strongSwan). Policy enforced with nftables (bridge + netdev
> families). No DPDK, no XDP, no custom packet processing — unless Phase 4
> measurements prove it necessary.**

```text
                         Appliance (one per site)
 ┌──────────────────────────────────────────────────────────────────────┐
 │  user space                                                          │
 │   ┌────────────────┐   ┌──────────────┐   ┌───────────────────────┐  │
 │   │ strongSwan     │   │ l2vpnctl     │   │ sshd (mgmt0 only)     │  │
 │   │ charon (IKEv2) │   │ config gen/  │   │ log/metrics exporter  │  │
 │   │ CAP_NET_ADMIN  │   │ validator    │   │ (unprivileged)        │  │
 │   └───────┬────────┘   └──────┬───────┘   └───────────────────────┘  │
 │   netlink │ XFRM SAs/policies │ writes swanctl.conf, networkd, nft   │
 ├───────────┼───────────────────┼──────────────────────────────────────┤
 │  kernel   ▼                   ▼                                      │
 │  lan0 ─► [nft bridge] ─► br0 ─► gre0 ─► XFRM/ESP ─► [nft netdev] ─► wan0
 │  (no IP)                (no IP)   (GRE WAN_A↔WAN_B)            (WAN IP)
 │                                                                      │
 │  mgmt0 (separate NIC/port, own IP, own routing table)                │
 └──────────────────────────────────────────────────────────────────────┘
```

Key properties:

- **br0 and lan0 have no IP address and IPv6 disabled** ⇒ the appliance is not
  addressable from the LAN, emits nothing onto the LAN itself.
- `wan0` has the only data-plane IP; it accepts only IKE, ESP and needed ICMP from
  the peer.
- GRE is accepted **only** when it was delivered by ESP (XFRM `in` policy with
  `level required` + nftables `meta ipsec missing` drop). Tested as an invariant.
- `br_netfilter` not loaded (no bridged traffic through iptables).

### 4.2 Why GRETAP rather than VXLAN (for point-to-point)

| | GRETAP (RFC 1701/2784 + TEB 0x6558) | VXLAN (RFC 7348) |
|--|--|--|
| Overhead | 4 B GRE + outer IP | 8 B UDP + 8 B VXLAN + outer IP (12 B more) |
| Tunnel-level FDB | none (p2p) | flood list / FDB needed |
| Entropy for RSS | none | UDP src port — **hidden inside ESP anyway**, so no benefit |
| Multi-segment | one gretap per segment, or VLAN trunk inside | VNI per segment |
| Multi-site / EVPN future | awkward | natural |
| NAT traversal | needs ESP-in-UDP (NAT-T) | same |

Inside ESP, VXLAN's main advantage (UDP entropy) disappears. For two sites,
GRETAP is simpler and cheaper. If Q3 says "multi-site later", VXLAN becomes
the better choice; the rest of the architecture is unchanged.

### 4.3 Why a Linux bridge rather than a pure "wire" (tc mirred)

A pure pseudowire (`tc ... action mirred redirect` lan0⇄gre0) is even simpler,
but forwards *every* frame seen on lan0 — including local-to-local unicast
flooded by the LAN switch — across the WAN. The bridge adds MAC learning (so
only frames for remote/unknown MACs cross), VLAN filtering, multicast snooping,
FDB limits and counters. Cost: a few hundred cycles/packet. Worth it.

---

## 5. Alternative architectures considered

| # | Architecture | Verdict |
|---|--------------|---------|
| A1 | **Bridge + GRETAP + IPsec ESP (IKEv2)** | **Recommended** (standards-based, kernel-native, mature, AES-NI/VAES). Main risk: inbound parallelism (§11.4). |
| A2 | Bridge + VXLAN + IPsec ESP | Equivalent; choose if multi-site/VNI needed. +12 B overhead. |
| A3 | Bridge + GRETAP/VXLAN over **WireGuard** | Strong alternative. Simplest config, small audited code, crypto parallelised across all CPUs *by design* (solves the inbound single-queue problem). Cons: not an IETF standard, no crypto agility (ChaCha20-Poly1305 only; no AES-GCM), no PKI/revocation (static keys), not FIPS-approvable. **Kept as the fallback if A1 cannot scale.** |
| A4 | MACsec (802.1AE, MKA) over GRETAP/VXLAN | Standards-based L2 crypto, but leaks inner MAC addresses in clear, MKA across an IP WAN is unusual, strict replay window vs WAN reordering, fewer deployments. Reject for v1. |
| A5 | L2TPv3 Ethernet pseudowire (RFC 3931) + IPsec | Standard, kernel support exists, but lower-maintenance kernel subsystem and no advantage over GRETAP. Reject. |
| A6 | OpenVPN TAP (user space) | TAP not supported by OpenVPN DCO; user-space copy per packet; ~1–3 Gbit/s realistic. Reject. |
| A7 | tinc / SoftEther / ZeroTier / custom TAP daemon | Non-standard or custom protocols, user space. Reject. |
| A8 | DPDK / FD.io VPP (L2 xconnect + GRE + IPsec + IKEv2 plugin) | Can reach far higher pps (tens of Mpps). Costs: dedicated polling cores (100 % CPU always), large codebase in TCB, NIC bound away from kernel, own IKE implementation less mature than strongSwan. **Only if Q2 requires small-packet line rate.** |
| A9 | NIC inline IPsec/MACsec offload (e.g. NVIDIA ConnectX-6 Dx / 7) | Violates "crypto on CPU" requirement; noted as a future scaling path. |
| A10 | XDP / AF_XDP custom forwarder | Would require custom crypto/ESP code in or near the data plane. Reject: adds trusted custom code for no demonstrated need. |

### 6. VPN technology comparison (focused)

| Criterion | IKEv2 + ESP (kernel XFRM) | WireGuard (kernel) | MACsec/MKA | OpenVPN TAP | VPP IPsec |
|-----------|--------------------------|--------------------|-----------|-------------|-----------|
| Standard | IETF RFC 7296 / 4303 / 4106 | Published protocol (Noise), not IETF | IEEE 802.1AE/X | proprietary protocol | IETF |
| Implementation maturity | Very high (strongSwan, kernel) | High, small codebase | Medium on Linux | High | Medium |
| Crypto agility / FIPS path | Yes (AES-GCM, CNSA-suite possible) | No | Yes | Yes | Yes |
| Auth / revocation | Certs, CRL/OCSP, raw keys, EAP | Static public keys only | CAK/PSK or 802.1X | Certs | Certs/PSK |
| PQ option | Hybrid ML-KEM via RFC 9370 [VERIFY] | PSK layer | — | — | limited |
| L2 transport | via GRETAP/VXLAN | via GRETAP/VXLAN | native | native (TAP) | native |
| 10 Gbit/s feasibility (large frames) | Yes, if multi-core RX solved (§11.4) | Yes, parallel by design | Yes | No | Yes |
| Small-packet pps | Limited (kernel) | Limited (kernel) | Limited | Poor | Good |
| Config complexity | Medium | Low | Medium | Medium | High |
| Overhead (IPv4, over GRETAP) | ~58–61 B | ~84–99 B (outer IP 20 + UDP 8 + WG hdr 16 + tag 16 + inner IP 20 + GRE 4 + pad to 16) | ~32 B + tunnel | ~70+ B | as ESP |
| Interoperability with other vendors | Excellent | Good (wg implementations) | Limited over IP | OpenVPN only | Good |

---

## 7. Hardware candidates

### 7.1 What the workload actually needs

- **x86-64 with VAES** (vectorised AES). Linux ≥ 6.11 has VAES-AVX512 and
  VAES-AVX2 AES-GCM implementations [VERIFY exact version]; these are 2–4× faster
  per core than classic AES-NI.
- **Homogeneous cores** — avoid Intel hybrid P/E-core parts for predictable
  per-queue performance (RSS spreads work evenly; an E-core becomes the bottleneck).
- **8–16 cores** at ≥ 3 GHz for kernel-stack 10 Gbit/s *both directions* with headroom.
- **One NUMA node** (single socket).
- **Two 10/25 GbE ports** on a mature Linux driver (Intel i40e/ice, NVIDIA mlx5)
  with many queues, RSS, and ideally **flow steering on ESP SPI** [VERIFY per NIC].
- ECC RAM and TPM 2.0 for production.

### 7.2 Shortlist

| # | Platform | CPU / cores | Crypto | RAM | NICs | PCIe | Est. 1500B throughput (kernel, ESP) [ESTIMATE] | Power | Dev complexity | Approx. cost / node [VERIFY] | Availability | Major risks |
|---|----------|-------------|--------|-----|------|------|------|------|------|------|------|------|
| **P1** | AMD **EPYC 4004/4005** (AM5) or Ryzen 9000 on server µATX board (e.g. ASRock Rack B650D4U, Supermicro H13SAE-MF) | 8–16 Zen 4/5 cores | AES-NI + VAES, AVX-512 | 32 GB DDR5 ECC UDIMM | add-in 2×10/25G (Intel E810-XXVDA2 or X710-DA2) + onboard 1G for mgmt | PCIe 5.0 x16 slot | 10–20 Gbit/s bidirectional | 65–170 W TDP, ~60–120 W typical | Low | US$1,300–2,200 | Good | Consumer-socket lifecycle; BMC hardening |
| **P2** | **Minisforum MS-A2** class mini-server (Ryzen 9 9955HX) [VERIFY NIC chip] | 16 Zen 5 cores | VAES, AVX-512 | 32–64 GB DDR5 SO-DIMM (non-ECC [VERIFY]) | 2×SFP+ 10G + 2×2.5G onboard | 1 slot | ~10–15 Gbit/s | ~35–100 W | Low | US$800–1,200 | Good (consumer) | No ECC, no BMC, consumer lifecycle, thermals; 10G ports only (no 25G WAN headroom) |
| **P3** | Intel **Xeon D-2700** (Ice Lake-D) embedded SoC board, e.g. Supermicro X12SDV series | 8–20 cores | AES-NI + VAES, AVX-512 | DDR4 ECC RDIMM | integrated E823 10/25G | PCIe 4.0 | 10–20 Gbit/s | 65–120 W | Low–Med | US$2,000–4,000 | Good, long lifecycle | Older node, lower clock, price |
| **P4** | Intel **Xeon 6 SoC** (Granite Rapids-D) [VERIFY availability] | up to many P-cores | VAES, AVX-512 | DDR5 ECC | integrated up to 100G Ethernet | PCIe 5.0 | >20 Gbit/s | 100 W+ | Med | high | Early | Early availability, price |
| P5 | Intel **Xeon E-2400 / Xeon 6300** + NIC | 4–8 P-cores | VAES (AVX2 width) | DDR5 ECC | add-in NIC | PCIe 5.0 | ~10 Gbit/s, little headroom | 55–95 W | Low | US$1,200–1,800 | Good | Core count tight for bidirectional 10G |
| P6 | Intel Core i-series hybrid (e.g. MS-01 with i9-12900H + X710) | P+E cores | VAES on P-cores | DDR5 | 2×SFP+ | — | variable | — | Med | US$700–1,000 | Good | Hybrid cores ⇒ unpredictable per-queue performance |
| P7 | ARM: NXP LX2160A (16× Cortex-A72, 4×10G) | 16 | ARMv8 CE | DDR4 | integrated | — | **< 10 Gbit/s in software** without DPAA2 SEC offload | ~30 W | High | ~US$800–1,200 | Medium | A72 per-packet kernel cost too high; crypto offload violates requirement |
| P8 | ARM: Ampere Altra / AmpereOne | 32–192 Neoverse cores | ARMv8 CE | DDR4/5 | add-in | PCIe 4/5 | enough via core count | 100–350 W | Med | US$3,000+ | Medium | Cost/power, no advantage over x86 for this workload |
| P9 | Intel Atom C3000/P5000, Intel N-series firewall boxes | 4–24 small cores | AES-NI (no VAES on older) | | | | **< 10 Gbit/s** | low | | cheap | | Too slow for software ESP at 10G |

**Conclusion:** x86-64, homogeneous Zen 4/5 or Intel P-cores with VAES. ARM
offers no technical advantage for CPU-only crypto at this price point.

### 7.3 Recommended platforms [DECISION]

**Development/evaluation:** 2× **P1** (identical appliances) — alternatively 2× P2
if budget-constrained and ECC/BMC are not needed during development.

- NIC: **Intel E810-XXVDA2** (2×25G, `ice` driver) — gives a 25G WAN port for
  headroom (§11.1) and can run at 10G. Fallback: Intel X710-DA2 (2×10G, `i40e`)
  or NVIDIA ConnectX-5/6 Lx (`mlx5`).

**Test infrastructure (required, often forgotten):**

- 1× **traffic generator / sink** host with a 2-port 10/25G NIC running
  TRex (DPDK) for pps tests and iperf3/pktgen for simple tests. Can be a third P1.
- Optional 1× **WAN emulator** (Linux + netem, 2-port NIC) for latency/loss/
  reorder/MTU tests. Initially the WAN is a direct DAC cable.
- DAC cables / SFP28 optics, a managed switch with VLAN/STP support to emulate LANs.

```text
 ┌─────────┐ p0  lan0 ┌────────┐ wan0      wan0 ┌────────┐ lan0  p1 ┌─────────┐
 │ TRex /  ├──────────┤ App. A ├── DAC or netem ─┤ App. B ├──────────┤ (same  │
 │ tester  │          └───┬────┘                 └───┬────┘          │ tester) │
 └─────────┘              └── mgmt switch ───────────┘               └─────────┘
```

**Production (later decision):** P1 in a 1U short-depth chassis with EPYC 4005,
or P3/P4 embedded SoC, with TPM 2.0, ECC, secure boot, redundant PSU if needed.
The choice depends on Q7 (quantity, environment, budget, lifecycle).

---

## 8. Linux networking architecture

| Mechanism | Use? | Reason |
|-----------|------|--------|
| Linux bridge | **Yes** | Learning, VLAN filtering, snooping, FDB limit, mature. |
| GRETAP | **Yes** | L2-in-IP, minimal overhead, kernel-native. |
| VXLAN | If multi-site (Q3) | See §4.2. |
| XFRM (kernel IPsec) | **Yes** | ESP data plane, uses kernel AES-GCM (VAES). |
| nftables (bridge + netdev families) | **Yes** | L2 policy, rate limits, WAN early drop. |
| tc (flower + police) | Maybe | If nftables rate limiting is too costly at 10G; measured in Phase 3. |
| TUN/TAP | No | User-space copies; no need. |
| macvlan | No | Not a bridging/tunnel primitive for this use. |
| XDP / eBPF | Not initially | Only for WAN DoS early-drop if nftables netdev ingress proves insufficient. |
| AF_XDP / DPDK | No | Only if Q2 demands small-packet line rate (A8). |

OS [DECISION]: **Debian 13 (trixie)** for development, with a newer LTS kernel
(≥ 6.13 for per-CPU IPsec SAs, §11.4) [VERIFY], and **strongSwan ≥ 6.x**.
Production: a minimal, reproducible, read-only image (Debian-based or
Buildroot/Yocto) with secure boot and dm-verity — decided in Phase 5.

Required sysctl/interface hygiene (to be scripted in Phase 3):

- `net.ipv6.conf.{br0,lan0,gre0}.disable_ipv6=1`, no IPv4 on br0/lan0.
- LRO off on bridged ports (kernel forces this), GRO on; RX/TX checksum offload on.
- Ring sizes, RSS queue count = cores, IRQ affinity pinned, `irqbalance` off or configured.
- CPU governor `performance`; C-states limited for latency tests.

---

## 9. Layer-2 security policy (proposed defaults)

Every restriction breaks *something*; the effect is listed.

### 9.1 Frame classes

| Frame class | Default | Effect / rationale |
|-------------|---------|--------------------|
| Known unicast (remote MAC) | Forward | Normal operation. |
| Known unicast (local MAC) | Not forwarded (bridge) | Saves WAN; normal bridge behaviour. |
| Unknown unicast | Forward (flood) | Required for correctness after FDB ageing. Bridge ageing set ≥ host ARP/ND timeouts (e.g. 300 s default) to minimise floods. Counted/alarmed. |
| Broadcast (ARP, DHCP, etc.) | Forward, **rate-limited** (e.g. 1–5 kpps, configurable) | Storm limiter. Too low ⇒ ARP loss during mass reboots. |
| IPv4 multicast 224.0.0.0/24 (link-local control) | Forward, rate-limited | Needed by VRRP, OSPF, mDNS… |
| IPv4/IPv6 routable multicast | Forward, rate-limited; IGMP/MLD snooping evaluated | Snooping on a 2-port bridge only prunes toward the tunnel when no remote listener; wrong querier setup ⇒ multicast loss. Evaluate in Phase 3. |
| IPv6 ND/RA/DAD (ff02::/16) | Forward, rate-limited | IPv6 breaks without it. Optional RA-guard (Q4). |
| DHCPv4/v6 | Forward | Optional block if each site has its own server (Q4). |
| 01:80:C2:00:00:00 STP BPDU | **Drop + alarm** (default); transparent mode optional | See §9.5. |
| 01:80:C2:00:00:01 PAUSE | Never forwarded (NIC consumes) | 802.3 requirement. |
| 01:80:C2:00:00:02 LACP/Slow protocols | Drop | LACP across a tunnel is meaningless/dangerous. |
| 01:80:C2:00:00:03 802.1X EAPOL | Drop (option: forward) | Forwarding lets a remote authenticator control local ports. |
| 01:80:C2:00:00:0E LLDP | Drop (option: forward) | Forwarding makes switches see each other as neighbours across WAN; leaks inventory. |
| Other 01:80:C2:00:00:0x | Drop | Link-local by definition. |
| 802.1Q VLAN IDs | **Allowlist** | Unlisted VLANs dropped. Untagged/native VLAN handling explicit in config. |
| 802.1ad S-tag (0x88a8) / double-tag | Drop unless QinQ enabled | Anti VLAN-hopping. |
| EtherType policy | Mode A (default) **denylist** known-dangerous; Mode B allowlist (IPv4/ARP/IPv6/VLAN) | Allowlist is safer but silently breaks PTP (0x88F7), PROFINET, FCoE, MPLS, etc. — Q4. |
| Oversize frames (> LAN MTU) | Drop + counter | Cannot fragment at L2. |
| Source MAC multicast/zero | Drop | Invalid per 802.3. |

### 9.2 MAC limits

Bridge-wide `fdb_max_learned` (e.g. 4096–16384) [VERIFY kernel version/semantics];
when exceeded new MACs are not learned ⇒ they get flooded (not dropped), which
the unknown-unicast counter exposes. Per-port limits would need nftables sets
or future kernel features.

### 9.3 Storm control

Linux bridge has no native storm control. Implemented with nftables `limit rate`
(or `tc police`) per class **on the way into the tunnel** and **on the way out
of the tunnel**. Measured cost must be < ~10 % in Phase 3.

### 9.4 VLAN handling

Tagged frames are carried with their tag inside GRETAP (inner frame includes the
802.1Q header). Inner frame max = MTU + 18 (single tag) or +22 (QinQ). The WAN
MTU budget in §11.2 includes the tag.

### 9.5 STP/BPDU — two modes [DECISION, Q4]

- **Isolated (default):** drop BPDUs at the tunnel, alarm on receipt. Each site is
  its own STP domain; WAN flaps don't cause topology changes at both sites.
  Risk: a *second* L2 path between sites creates an undetected loop ⇒ storm
  control limits damage.
- **Transparent:** bridge STP off, BPDUs forwarded (Linux bridge forwards BPDUs
  when STP is disabled). One STP domain spanning the WAN; WAN latency/loss can
  cause topology churn or, if BPDUs are lost, loops. Only if the customer
  explicitly needs redundant L2 paths between sites.

---

## 10. Key-management architecture

| Aspect | Design |
|--------|--------|
| Protocol | IKEv2 (RFC 7296) via strongSwan `charon-systemd` + `swanctl`. |
| Authentication | Mutual X.509, ECDSA P-384 or Ed25519, from a small **offline private CA**; peer identity (SAN) pinned in config. Alternative: raw public keys (RFC 7670) — simpler, no CA, revocation = config change. **PSK rejected.** |
| Key generation | On the appliance (`pki --gen` / TPM). Only CSR leaves the device. |
| Key storage | Dev: file, root-only, 0600, on encrypted partition. Prod: **TPM 2.0**-resident private key (strongSwan tpm plugin) [VERIFY]. |
| Key exchange | ECDH (x25519 or ECP-384); optional hybrid **ML-KEM-768** additional key exchange (RFC 9370) [VERIFY strongSwan ≥ 6.0]. |
| Data-plane crypto | ESP AES-256-GCM-16 (RFC 4106), ESN on, anti-replay window sized for reordering (e.g. 1024+). |
| Rekey | CHILD_SA rekey by time (~1 h) and bytes (e.g. few hundred GB) with make-before-break; IKE_SA rekey ~4–24 h; PFS on every CHILD_SA rekey. |
| Credential rotation | Certificate validity ~1 year, renewal via new CSR, overlapping validity. |
| Revocation | Two-node system: remove/replace the pinned peer identity and CA-issued cert, plus CRL published to both nodes via mgmt. Revocation must not depend on WAN reachability of an OCSP server. |
| After reboot | Long-term keys persist (disk/TPM); session keys are RAM-only and gone; IKE re-establishes automatically; bridge forwards nothing to WAN until SA is up (no plaintext fallback — enforced by XFRM policy "block" when no SA). |
| Peer compromised | Revoke peer cert, bring tunnel down, re-provision peer with new key. Past traffic protected by PFS; traffic of the current SAs is exposed. Attacker had L2 access to our LAN during compromise. |
| Secrets in management | Never displayed; CLI shows fingerprints only. `swanctl --list-sas` output without keys. No `ip xfrm state` exposure to non-root. |

WireGuard fallback (A3): static Curve25519 keys generated on-device, optional PSK
for PQ-mitigation, rotation = config change on both ends, no revocation mechanism
beyond removing the peer.

---

## 11. Performance analysis

### 11.1 Wire-level limits (physics, independent of CPU)

L1 overhead per frame = 20 B (preamble 8 + IFG 12). Tunnel adds ~60 B
(IPv4 ESP transport over GRETAP, §11.2). Numbers per direction.

| Inner frame (incl. FCS) | LAN pps at 10 Gbit/s | WAN frame | Max pps on 10G WAN | Max inner rate over 10G WAN |
|--|--|--|--|--|
| 64 B | 14.88 Mpps | ~124 B | 8.68 Mpps | **58 %** of LAN line rate |
| 128 B | 8.45 Mpps | ~188 B | 6.01 Mpps | 71 % |
| IMIX (7:4:1 of 64/594/1518, avg 362 B) | 3.27 Mpps | ~422 B | 2.83 Mpps | 86 % |
| 512 B | 2.35 Mpps | ~572 B | 2.11 Mpps | 90 % |
| 1518 B | 813 kpps | ~1578 B | 782 kpps | 96 % |
| 9018 B (jumbo) | 138 kpps | ~9078 B | 137 kpps | 99 % |

**Consequence:** LAN line rate over a same-speed WAN is impossible for any
frame size. "10 Gbit/s" must mean one of (Q2):

- (a) 10 Gbit/s of *WAN* throughput (≈ 9.6 Gbit/s LAN goodput at 1518 B), or
- (b) 10 Gbit/s of *LAN* throughput ⇒ WAN link must be > 10G (25 GbE port, and
  a WAN service > 10.5 Gbit/s).

### 11.2 Encapsulation overhead and MTU

IPv4 outer, ESP transport, AES-GCM, GRETAP:

| Component | Bytes |
|-----------|-------|
| Outer IPv4 | 20 |
| ESP header (SPI + seq) | 8 |
| GCM IV | 8 |
| GRE | 4 |
| *Inner Ethernet frame (no FCS)* | L |
| ESP padding + pad-len + next-hdr | 2–5 |
| ICV | 16 |
| **Total added** | **58–61** |

+20 B for IPv6 outer, +8 B for NAT-T (ESP-in-UDP), +20 B for tunnel mode.

Required WAN **IP MTU** to carry a full 1500-byte LAN payload:

| Inner | Required WAN MTU (IPv4, no NAT) |
|-------|--------------------------------|
| untagged (1514) | 1572 |
| 802.1Q (1518) | 1576 |
| QinQ (1522) | 1580 |
| 9000 jumbo + tag | ~9080 |

**Recommendation:** WAN path MTU **≥ 1600** (IPv4) / **≥ 1620** (IPv6).

If the WAN is a 1500-MTU Internet path, options are:

1. **Outer fragmentation** (GRE `nopmtudisc`/ESP fragments): transparent but
   doubles WAN pps for large frames, reassembly on the receiver (single-CPU,
   DoS surface, loss amplification). Throughput drop likely 30–50 % [ESTIMATE].
2. **Reduce LAN MTU** to ~1420 on all hosts: fast, but not transparent;
   any host sending 1500 is silently black-holed (a bridge cannot send ICMP PTB).
3. **TCP MSS clamping** — not possible on a pure bridge without br_netfilter; rejected.

This is Open Question Q1 and it has the largest impact on design.

### 11.3 CPU budget [ESTIMATE]

Per packet, kernel path (NIC RX + GRO + bridge + gretap + XFRM + NIC TX):
roughly 1,500–4,000 cycles of stack work + crypto at ~0.5–1 cycle/byte
(VAES AES-GCM).

| Frame | pps per direction | Cycles/pkt (est.) | Cores per direction @ 3.5 GHz |
|-------|------------------|--------------------|-------------------------------|
| 1518 B | 0.81 M | ~3,000–5,500 | **~1–1.5** |
| IMIX | 3.3 M | ~2,500–4,000 | **~2.5–4** |
| 64 B | 14.9 M | ~2,000–3,500 | **~9–15** (infeasible to scale linearly; cache/lock contention) |

Bidirectional ×2. Hence 8–16 cores comfortably covers 10G at IMIX/large
frames **if work is spread across cores**. Small-packet line rate is only
realistic with DPDK/VPP (A8).

GRO/GSO help TCP-heavy traffic considerably (fewer, larger packets through
the bridge and GRE; ESP GSO segments before encryption), so real TCP workloads
will do better than per-packet numbers suggest.

### 11.4 The critical risk: multi-core scaling of the tunnel

- **Outbound:** naturally parallel. LAN NIC RSS spreads inner flows across CPUs;
  each CPU encapsulates and encrypts on its own. With a *single* SA all CPUs
  contend on the SA lock/sequence counter. Mitigation: **per-CPU SAs**
  (RFC 9611, Linux ≥ 6.13 `XFRMA_SA_PCPU`, strongSwan support [VERIFY version]).
- **Inbound:** the WAN sees one outer IP pair with protocol 50. Most NICs hash
  non-TCP/UDP traffic on the IP pair only ⇒ **everything lands on one RX queue
  ⇒ one CPU decrypts ⇒ ~3–6 Gbit/s ceiling** [ESTIMATE].
  Mitigations, in order of preference:
  1. Per-CPU SAs + NIC flow rules steering by ESP SPI (ethtool ntuple / RSS on
     SPI) [VERIFY per NIC: E810, X710, ConnectX].
  2. RPS on wan0 (software steering) if the flow dissector hashes SPI [VERIFY].
  3. `pcrypt` (parallel crypto template, padata) for the AEAD — parallel
     decryption with order preservation.
  4. ESP-in-UDP with multiple source ports (NAT-T style) for RSS entropy [VERIFY feasibility].
  5. Fallback to WireGuard (A3), which parallelises decryption across all
     CPUs internally.

This is the first thing Phase 4 will measure. If none works adequately,
A3 is the fallback and I'll ask you before switching.

### 11.5 Other resources

- **Memory bandwidth:** 2 × 10 Gbit/s ≈ 2.5 GB/s of payload, touched ~3–4 times
  (DMA in, crypto read/write, DMA out) ≈ 10 GB/s. Dual-channel DDR5 ≈ 60–80 GB/s. Not a constraint.
- **PCIe:** 2×25G NIC needs PCIe 3.0 x8 or 4.0 x8 (≈ 8/16 GB/s). Not a constraint.
- **NUMA:** single socket ⇒ none. On multi-socket, NIC, IRQs and cores must share a node.
- **Latency:** kernel path adds ~5–50 µs per appliance [ESTIMATE] depending on load
  and interrupt moderation. Negligible vs. WAN RTT unless sites are < 1 km apart.
- **Context switches / copies:** none in the data plane (kernel only, zero
  user-space transitions). Encryption is in-place.

### 11.6 Is 10 Gbit/s achievable?

| Scenario | Verdict |
|----------|---------|
| 10 Gbit/s WAN throughput, 1500 B / TCP-heavy traffic, WAN MTU ≥ 1600, kernel stack | **Very likely**, provided §11.4 is solved. |
| Same, IMIX | **Likely** with 8–16 Zen 4/5 cores. |
| 10 Gbit/s over 1500-MTU WAN with fragmentation | **Uncertain / unlikely** at full rate. |
| 64-byte frames at LAN line rate | **Impossible** over a 10G WAN (physics); needs >10G WAN *and* DPDK/VPP. |

---

## 12. Component / BOM requirements (Phase 1 level)

Exact part numbers and prices come in Phase 2 after Q1–Q7 are answered.

| Qty | Component | Requirement |
|-----|-----------|-------------|
| 2 | Appliance CPU | x86-64, VAES, 8–16 homogeneous cores, ≥ 3 GHz, single socket (EPYC 4004/4005 or Ryzen 9000 class) |
| 2 | Mainboard | Server µATX, ECC support, TPM 2.0 header, PCIe 4/5 x8+ slot, onboard 1G for mgmt, IPMI optional (isolate) |
| 2 | RAM | 2× 16 GB DDR5 ECC UDIMM (dual channel) |
| 2 | Data-plane NIC | 2-port 10/25G, Intel E810-XXVDA2 (preferred) / X710-DA2 / ConnectX-5/6 Lx |
| 2 | Boot storage | 256–512 GB NVMe (enterprise or PLP preferred for prod) |
| 2 | TPM 2.0 module | matching board header |
| 2 | Chassis + PSU | 1U/2U or tower for dev; 80+ Gold/Platinum |
| 1 | Traffic generator | 3rd node similar to above, 2-port NIC, TRex |
| (1) | WAN emulator | optional 4th node or reuse tester with netem |
| 6+ | DAC cables SFP+/SFP28 | 1–3 m |
| 1 | Managed switch | VLAN/STP/LLDP capable (to emulate LAN behaviour) |
| 1 | Mgmt switch / USB-serial console cables | for OOB access |

---

## 13. Major risks

| # | Risk | Impact | Likelihood | Mitigation |
|---|------|--------|-----------|-----------|
| R1 | Inbound ESP single-queue bottleneck | < 10G | High | §11.4; early measurement; WireGuard fallback |
| R2 | WAN MTU only 1500 | Throughput loss or non-transparency | Unknown (Q1) | Carrier MTU ≥ 1600; else fragmentation, measured |
| R3 | "10 Gbit/s" ambiguous / small-packet requirement | Architecture change to DPDK/VPP | Medium | Q2 |
| R4 | Per-CPU SA support immature in kernel/strongSwan | Scaling | Medium | Version pinning, alternatives 2–5 in §11.4 |
| R5 | L2 loops / storms across sites | Outage at both sites | Medium | BPDU policy, storm control, monitoring |
| R6 | Remote site compromise → local L2 attack | Security | Inherent | Document; L2 policy; optional ARP/RA/DHCP guards |
| R7 | Plaintext GRE accepted due to misconfig | Unauthenticated injection | Low if tested | Invariant test in CI and at startup |
| R8 | BMC/IPMI vulnerabilities | Full compromise | Medium | Disable or isolate BMC; no BMC on production if possible |
| R9 | Consumer-platform lifecycle / availability | Production supply | Medium | Choose embedded/server SKUs for production |
| R10 | Kernel regressions in bridge/XFRM performance | Throughput | Low–Med | Pin LTS, performance regression tests (Phase 6) |
| R11 | Price/availability figures here are approximate | Budget | — | Phase 2 verification |

---

## 14. Open questions (need your answers)

**Q1 — WAN characteristics (most important).**
What is the WAN between the sites? (Internet, dedicated fiber, carrier Ethernet/
MPLS L3VPN?) What link speed (10G or faster)? What path MTU can it carry — can
you get ≥ 1600 bytes? Is there NAT between the sites? Static public IPs? IPv4, IPv6 or both?

**Q2 — Definition of "10 Gbit/s".**
Per direction or aggregate? Measured on the LAN or the WAN side? For what
traffic mix: large TCP flows, IMIX, or small packets? Is 64-byte line rate a hard
requirement (this would force DPDK/VPP)?

**Q3 — Topology.**
Strictly two sites, point-to-point? Any plans for more sites (hub/mesh)?
Is high availability (two appliances per site, failover) required?

**Q4 — LAN traffic and L2 policy.**
Untagged access or VLAN trunk (which VLANs)? Jumbo frames on the LAN? Do the
sites run STP, and are there *other* L2 paths between them? Must LLDP/LACP/
802.1X/PTP or other non-IP EtherTypes pass? One DHCP server for both sites or one per site?
Does multicast matter (which applications)?

**Q5 — Standards and compliance.**
Must the protocol be an IETF standard (IPsec) or is WireGuard acceptable?
Any FIPS 140-3, CNSA 2.0, BSI or other compliance target? Post-quantum
requirement?

**Q6 — Management.**
Is a third physical management port acceptable (recommended)? Is remote
management needed, and if so over what path (dedicated mgmt network, or
in-band through the tunnel)? Existing syslog/monitoring (Prometheus, SNMP)?

**Q7 — Budget, quantity, environment.**
Development budget? How many production units, what environment (rack, office,
industrial, fanless)? Required product lifecycle?

**Q8 — PKI.**
Do you have an existing PKI you want to use, or should we create a small
dedicated offline CA (or use raw public keys)?

---

## Next steps

1. You answer Q1–Q8 and confirm or reject the [DECISION] items:
   - A1 architecture (bridge + GRETAP + IKEv2/ESP), with WireGuard as fallback.
   - GRETAP vs VXLAN.
   - Default L2 policy in §9 (especially BPDU isolation and EtherType mode).
   - Development hardware P1 (or P2) + dedicated traffic generator.
2. Phase 2: exact hardware list with part numbers, verified prices and alternatives.
3. Phase 3: plain bridge `LAN ↔ Linux ↔ WAN` bring-up and baseline measurements
   (including an unencrypted GRETAP baseline between the two appliances).
