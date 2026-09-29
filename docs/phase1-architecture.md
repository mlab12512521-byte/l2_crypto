# Phase 1 — Requirements, Threat Model and Architecture

Status: **DRAFT v0.2 for review.** No implementation code is written in this phase.

Revision history:

- v0.1 — assumed an IP WAN (Ethernet-over-IP + IPsec/WireGuard). **Superseded.**
- v0.2 — requirement clarified: the two appliances are **directly connected over
  the owner's own fiber (~500 m)**. The design is now point-to-point Ethernet
  link encryption with **IEEE 802.1AE MACsec + MKA**. The IP-based designs are
  kept only in §5 as rejected alternatives.

Conventions:

- **[DECISION]** — recommendation that needs your confirmation.
- **[VERIFY]** — fact / version / feature / price to be checked against current
  documentation or by measurement before we rely on it.
- **[ESTIMATE]** — planning number, replaced by measurements in Phase 6.

---

## 1. Requirements summary

### 1.1 Functional

| ID | Requirement |
|----|-------------|
| F1 | Transparently transport Ethernet frames between LAN A and LAN B. |
| F2 | The two appliances are directly connected by a dedicated fiber (~500 m); no IP routing, no intermediate devices. |
| F3 | Each appliance: one **LAN** port, one **link** port (to the peer), plus (proposed) a separate **management** port. |
| F4 | All frames on the fiber are encrypted and integrity-protected; no plaintext fallback ever. |
| F5 | IPv4, IPv6, ARP, ND, DHCP, VLAN-tagged traffic carried; other frame classes per explicit policy (§9). |
| F6 | Full 1500-byte (optionally jumbo) LAN MTU carried without loss — possible because we control the link MTU. |

### 1.2 Non-functional (your priority order)

1. Security 2. Correct L2 behaviour 3. ≥ 10 Gbit/s 4. Reasonable complexity
5. Maintainability 6. Cost-effective hardware.

### 1.3 Constraints

- Crypto on the CPU (no NIC/PHY MACsec offload).
- Standard protocols, mature implementations; no custom crypto or protocol.
- Linux; C only where custom low-level code is really needed.

### 1.4 Non-goals (proposed)

- Not a router/firewall/IDS for LAN hosts.
- No multi-site; strictly two appliances on one fiber.
- Hiding frame sizes/timing/MAC addresses on the fiber (see §2.6).

---

## 2. Threat model

### 2.1 Protected assets

| Asset | Why |
|-------|-----|
| A1 Confidentiality of LAN traffic on the fiber | Primary goal. |
| A2 Integrity/authenticity of frames entering a LAN from the fiber | Injection = full L2 access to a site. |
| A3 CAK (long-term MKA key) | Compromise ⇒ impersonation **and decryption of recorded traffic** (§10.3). |
| A4 SAKs (session keys) | Compromise ⇒ decryption of that SA's traffic. |
| A5 Configuration (policy, CKN/CAK, VLAN allowlist) | Tampering ⇒ bypass/redirection. |
| A6 Availability of the link | Infrastructure-critical. |
| A7 Management credentials | Admin = everything. |

### 2.2 Trust boundaries

```text
 LAN A (semi-trusted)        fiber (untrusted medium)        LAN B (semi-trusted)
┌────────────┐ TB1 ┌─────────────┐    TB2    ┌─────────────┐ TB1' ┌────────────┐
│ hosts/switch├────┤ Appliance A ├═══════════┤ Appliance B ├──────┤hosts/switch│
└────────────┘     └──────┬──────┘           └──────┬──────┘      └────────────┘
                          │ TB3 management           │ TB3
```

- **TB1 LAN ↔ appliance:** LAN hosts may be malicious and send arbitrary frames.
- **TB2 fiber:** an attacker with physical access can tap, inject, replay, cut.
- **TB3 management:** trusted operators only, separate interface.
- **Peer appliance:** trusted; a compromised peer = full L2 access to our LAN.
- **TCB inside the appliance:** Linux kernel (bridge, macsec, crypto) and
  `wpa_supplicant` (MKA). Everything else unprivileged.

### 2.3 Security assumptions

1. Kernel MACsec + crypto and wpa_supplicant MKA are correct enough; we track updates.
2. CPU, NIC firmware and BMC are not malicious; BMC disabled or isolated.
3. The CAK is generated securely and stored only on the two appliances.
4. Physical access to the *appliances* is controlled; physical access to the
   *fiber* is not assumed controlled.
5. Operators and management network are trusted.

### 2.4 Attack surfaces

| Surface | Exposed to | Handled by |
|---------|-----------|------------|
| Fiber: MACsec frames (EtherType 0x88E5) | fiber attacker | kernel `macsec` RX (SecTAG parse, SA lookup, replay check, AES-GCM verify) |
| Fiber: EAPOL-MKA frames (0x888E) | fiber attacker | `wpa_supplicant` MKA parser (user space, C) — **pre-authentication parser, most exposed user-space code** |
| Fiber: any other frame | fiber attacker | dropped (link port is not bridged, has no IP) |
| LAN: any Ethernet frame | LAN hosts | NIC, bridge, nftables bridge family |
| Decrypted frames from peer | peer site's hosts | bridge, nftables |
| Management port | admin network | sshd |
| Console / BMC / boot | local attacker | firmware, bootloader |

### 2.5 Threat analysis

| Threat | Mitigation | Residual risk / limitation |
|--------|-----------|----------------------------|
| Tapping the fiber | MACsec AES-256-GCM encryption | MACs/sizes/timing visible (§2.6). |
| Frame injection / modification | GCM ICV, `validate strict`; link port not bridged ⇒ unprotected frames never reach a LAN | — |
| Replay | MACsec PN + replay protection | With `replay_window > 0`, 802.1AE only rejects PN below the window's lower edge; **duplicates inside the window are accepted**. Target `replay_window = 0` (strict order) unless measurements force otherwise (§11.4). |
| Plaintext fallback (MKA down) | Only `macsec0` is a bridge port; `wan0` is never bridged ⇒ no SA = no forwarding | Must be tested as an invariant. |
| PN exhaustion / nonce reuse | XPN (64-bit PN) cipher suite, or MKA SAK rekey before exhaustion | [VERIFY] wpa_supplicant XPN support. |
| CAK compromise | CAK rotation; TPM-sealed storage in production | **Static-CAK MKA has no forward secrecy**: recorded traffic can be decrypted with the CAK (§10.3). |
| Peer impersonation | MKA ICV with CAK-derived ICK | Anyone with the CAK can impersonate. |
| MKA protocol attacks (malformed MKPDUs, DoS) | wpa_supplicant hardening, rate limit EAPOL on link port, sandboxing (§11) | Parser bugs in wpa_supplicant. |
| Compromised peer appliance | L2 policy, MAC limit, rate limits | Attacker has L2 adjacency to our LAN. Inherent to an L2 extension. |
| Compromised local appliance | Secure boot, read-only rootfs, TPM (prod) | Both LANs' link traffic exposed. |
| MAC flooding | bridge `fdb_max_learned` [VERIFY], ageing | Remote switch CAM pressure within rate limits. |
| Broadcast / multicast storms | per-class rate limits in both directions | Legit bursts may be dropped if limits too low. |
| ARP/ND/DHCP/RA spoofing across sites | Optional guards (§9) | Same as any flat L2 network. |
| VLAN hopping / double tagging | VLAN allowlist, drop 0x88a8/nested unless enabled | Customer native-VLAN mistakes out of scope. |
| STP/BPDU attacks, loops | BPDUs dropped by default + alarm; storm control backstop | Loops via other paths not detected by us. |
| Fiber cut / jamming | none (physical) | Availability not guaranteed; optional second fiber later. |
| Management-plane attack | Separate port, nothing listening on LAN/link, SSH keys only | — |

### 2.6 What this system does **not** provide

- **MAC addresses of LAN hosts are visible on the fiber.** MACsec keeps the
  original DA/SA in clear; EtherType, VLAN tag and payload are encrypted.
- Frame sizes, timing and volume are visible.
- No forward secrecy with static CAK (§10.3).
- No protection against hosts at the other site (same L2 segment).
- No protection if either appliance is compromised.
- Encryption covers the fiber only; LANs are plaintext.

---

## 3. Layer-2 data flow

### 3.1 LAN A → fiber

```text
LAN wire → NIC lan0 (FCS check, RSS on inner IP/L4 hash → N queues/CPUs)
  → [nftables bridge] EtherType/VLAN/BPDU policy, bcast/mcast rate limits
  → bridge br0: VLAN filter, learn src MAC, lookup dst
      ├ dst on lan0 → not forwarded (local traffic)
      └ dst on macsec0 / unknown / bcast / mcast → macsec0
  → macsec0 TX: insert SecTAG, AES-256-GCM encrypt, append ICV (on the same CPU)
  → NIC wan0 TX → fiber
```

### 3.2 Fiber → LAN A

```text
fiber → NIC wan0 RX  ⚠ all frames are EtherType 0x88E5 → likely ONE RX queue (§11.4)
  ├ 0x888E EAPOL-MKA → wpa_supplicant (raw socket)
  ├ 0x88E5 MACsec → macsec RX: SCI/SA lookup → replay check → AES-GCM verify+decrypt
  │     → macsec0 → bridge br0 (learn src on macsec0) → [nftables] → lan0 TX → LAN
  └ anything else → dropped (wan0 not bridged, no IP)
```

### 3.3 Where each function lives

| Function | NIC | Kernel | User space |
|----------|-----|--------|------------|
| FCS / runt / giant | ✔ | | |
| RSS / queue steering | ✔ | (RPS, XDP cpumap if needed) | ethtool config |
| MAC learning, flooding, VLAN filter | | ✔ bridge | |
| L2 policy, rate limits | | ✔ nftables / tc | config |
| MACsec encrypt/decrypt, replay check | | ✔ `macsec` driver + kernel AES-GCM | |
| MKA: peer auth, key server election, SAK distribution/rotation | | | ✔ wpa_supplicant |
| Config generation / validation | | | ✔ small tool |
| Monitoring | | counters | ✔ unprivileged exporter |

Custom data-plane code: **none** (unless §11.4 forces a small XDP program).

---

## 4. Proposed architecture [DECISION]

> **Linux bridge `br0` = { `lan0`, `macsec0` }, where `macsec0` sits on the fiber
> port `wan0`. Encryption by the kernel `macsec` driver (GCM-AES-256, XPN if
> available), keys by MKA (IEEE 802.1X-2020) in `wpa_supplicant` with a static
> CAK. L2 policy with nftables. No IP on any data-plane interface.**

```text
                              Appliance
 ┌──────────────────────────────────────────────────────────────────┐
 │ user space                                                       │
 │  wpa_supplicant (MKA)    l2cryptctl (config gen/validate)   sshd │
 │  CAP_NET_ADMIN+RAW          writes configs, no secrets shown  mgmt0│
 ├─────────┬────────────────────────────────────────────────────────┤
 │ kernel  │ netlink (SA install)                                   │
 │  lan0 ─[nft bridge]─ br0 ─ macsec0 ═(SecTAG+GCM)═ wan0 ── fiber   │
 │  no IP              no IP   no IP                  no IP          │
 │  mgmt0: own IP, only interface with IP                           │
 └──────────────────────────────────────────────────────────────────┘
```

Key properties:

- **Fail-closed by construction:** `wan0` is never a bridge port. Without a valid
  SA, `macsec0` cannot transmit or receive; nothing plaintext crosses.
- `macsec0`: `encrypt on`, `validate strict`, `protect on`, `replay on`
  (`window 0` target), cipher GCM-AES-XPN-256 or GCM-AES-256.
- `send_sci` can be disabled on a point-to-point link (saves 8 B) [VERIFY
  interoperability with MKA settings].
- Link MTU raised on both ends (we own the fiber): `wan0` MTU e.g. 9216 ⇒
  `macsec0` carries 1500 or jumbo LAN frames with VLAN tags.
- IPv6 disabled and no IPv4 on `lan0`, `br0`, `macsec0`, `wan0`.
- `br_netfilter` not loaded.

### 4.1 Sanity check: hardware MACsec switches (excluded by requirement)

With your own fiber, a pair of MACsec-capable switches (many enterprise
switches do MACsec in hardware at line rate) would be the conventional
solution and achieve line rate at every frame size. It is excluded because
you require CPU-based crypto. I mention it once so the decision is
deliberate: the CPU appliance gives you open, inspectable software and
policy control; switches give you line-rate small-packet performance.

---

## 5. Alternatives considered

| # | Option | Verdict |
|---|--------|---------|
| **M1** | **MACsec + MKA static CAK (kernel + wpa_supplicant)** | **Recommended.** Standard, native L2, smallest overhead, interoperable with switch vendors. |
| M2 | MACsec + MKA with EAP-TLS (802.1X authenticator + EAP server, e.g. hostapd) | Adds per-session keys derived from TLS (forward secrecy for CAK) and certificate auth. More moving parts. **Candidate for Phase 5** if forward secrecy is required. [VERIFY hostapd wired+MACsec support] |
| M3 | MACsec with static SAKs (`ip macsec` manual keys, no MKA) | Simplest, but no automatic rekey, PN exhaustion handling or peer liveness. Useful **only for Phase 4 bring-up tests**. |
| M4 | MACsec, but frames first wrapped (e.g. GRETAP/VXLAN between appliances) to hide LAN MACs | Hides host MACs on the fiber; costs 38–50 B/frame and complexity. Only if §2.6 MAC visibility is unacceptable. |
| X1 | Ethernet-over-IP + IPsec/WireGuard over the fiber (v0.1 design) | Works, gives forward secrecy (IKEv2 / Noise), but is an IP tunnel on a link that doesn't need IP; larger overhead; you explicitly don't want this. Rejected. |
| X2 | OpenVPN TAP | Too slow. Rejected. |
| X3 | Proprietary "Layer-2 encryptor" protocols | Non-standard. Rejected. |
| X4 | Custom DPDK/AF_XDP MACsec | Would mean writing MACsec + crypto integration ourselves. Rejected unless 64-byte line rate is mandatory and nothing else works. |
| X5 | NIC/PHY MACsec offload (e.g. NVIDIA ConnectX-6 Dx/7, some PHYs) | Violates CPU-crypto requirement; noted as future scaling path. |

---

## 6. Protocol details

| Item | Value |
|------|-------|
| Standard | IEEE 802.1AE-2018 (MACsec), IEEE 802.1X-2020 (MKA) |
| Cipher suite | GCM-AES-XPN-256 (preferred) or GCM-AES-256 |
| Overhead | SecTAG 8 B (+ SCI 8 B) + ICV 16 B = **24–32 B per frame** |
| Replay | PN check, window 0 target |
| Key hierarchy | CAK (pre-shared, 256-bit) + CKN → KEK / ICK → key server generates random SAK, distributes it wrapped with KEK |
| Rekey | New SAK on PN threshold, on peer change, and optionally periodic [VERIFY wpa_supplicant options] |
| Liveness | MKA hello (default 2 s), peer timeout ~6 s |

---

## 7. Hardware candidates

### 7.1 Requirements derived from the workload

- x86-64 with **VAES** (vectorised AES-GCM in the kernel, AVX-512/AVX2) [VERIFY
  kernel version for VAES GCM].
- **Homogeneous cores** (no P/E hybrid), 8–16 cores, high clock — single-core
  performance matters because of the RX-queue issue (§11.4).
- Two data ports: LAN 10G, link 10G **or 25G** (see §11.1), mature driver
  (Intel `ice`/`i40e`, NVIDIA `mlx5`), plus a separate management port.
- ECC, TPM 2.0 for production.

### 7.2 Link optics — depends on fiber type (Q-A)

| Fiber | 10G | 25G | Notes |
|-------|-----|-----|-------|
| Single-mode (OS2) | 10GBASE-LR (10 km) | 25GBASE-LR (10 km) | 500 m is trivial; **recommended** |
| Multimode OM4 | 10GBASE-SR spec'd to 400 m — **500 m is out of spec** | 25GBASE-SR only 100 m | Would need non-standard "extended SR" optics or new fiber |
| Multimode OM3 | 10GBASE-SR 300 m — out of spec | — | Not suitable |

Intel NICs may restrict third-party optics [VERIFY for E810/X710] — Phase 2.

### 7.3 Platform shortlist

| # | Platform | Cores / crypto | NIC | Est. MACsec throughput 1500 B [ESTIMATE] | Approx. cost/node [VERIFY] | Risks |
|---|----------|----------------|-----|-----|-----|------|
| **P1** | AMD **EPYC 4004/4005** or Ryzen 9000 on server µATX board (ASRock Rack B650D4U / Supermicro H13SAE-MF class) | 8–16 Zen 4/5, VAES, AVX-512, high clock | add-in Intel **E810-XXVDA2** (2×10/25G) + onboard 1G mgmt | 10G per direction if RX spreading works; ~4–8 Gbit/s per core otherwise | US$1,300–2,200 | Consumer socket lifecycle; isolate BMC |
| P2 | Minisforum MS-A2-class mini server (Ryzen 9 9955HX) | 16 Zen 5, AVX-512 | 2×SFP+ onboard [VERIFY chip] | similar, 10G link only | US$800–1,200 | No ECC [VERIFY], no BMC, no 25G |
| P3 | Intel **Xeon D-2700** embedded board | 8–20, AVX-512 VAES | integrated E823 10/25G | similar, lower clock | US$2,000–4,000 | Price, lower single-core perf |
| P4 | Intel **Xeon 6 SoC** (Granite Rapids-D) | many P-cores | integrated | high | high | Early availability [VERIFY] |
| P5 | Intel Xeon E-2400 / 6300 + NIC | 4–8 P-cores, VAES-AVX2 | add-in | ~10G, little headroom | US$1,200–1,800 | Few cores |
| ✗ | Intel hybrid (P/E) mini PCs, Atom/N-series, ARM A72 (LX2160A), Ampere | — | — | — | — | Hybrid unpredictability / too slow per core / no advantage |

### 7.4 Recommendation [DECISION]

- **Development:** 2× **P1** + Intel E810-XXVDA2 + single-mode LR optics
  (or a short patch fiber/DAC on the bench — distance doesn't matter for testing).
- **Traffic generator:** a 3rd machine with a 2-port 10/25G NIC running TRex
  (DPDK) and iperf3/pktgen. Needed to measure pps honestly.
- **Production:** decided later (P1 in 1U, or P3/P4 embedded) — depends on
  quantity, environment, lifecycle (Q-F).

```text
 ┌────────┐ p0   lan0 ┌────────┐ wan0 ═══ fiber/patch ═══ wan0 ┌────────┐ lan0  p1 ┌────────┐
 │ tester ├───────────┤  App A │                               │  App B ├──────────┤ tester │
 └────────┘           └───┬────┘                               └───┬────┘          └────────┘
                          └──────────── mgmt switch ───────────────┘
```

---

## 8. Linux networking architecture

| Mechanism | Use | Reason |
|-----------|-----|--------|
| Linux bridge | **Yes** | Learning, VLAN filter, FDB limit, snooping, counters. |
| `macsec` netdev | **Yes** | Kernel-native 802.1AE. |
| wpa_supplicant (`macsec_linux` driver) | **Yes** | MKA implementation. |
| nftables bridge family (or tc) | **Yes** | L2 policy, rate limits. |
| RPS / XDP cpumap | Only if §11.4 requires | Spread RX decryption across cores. |
| GRETAP/VXLAN/IPsec/WireGuard | No | No IP link (see M4 for the MAC-hiding exception). |
| TUN/TAP, AF_XDP, DPDK | No | No demonstrated need. |

OS [DECISION]: **Debian 13** for development with a current LTS kernel [VERIFY
which version has the best MACsec/VAES state]; recent wpa_supplicant (2.11+)
[VERIFY MKA feature set]. Production: minimal read-only image, secure boot, dm-verity (Phase 5).

---

## 9. Layer-2 policy (proposed defaults)

Every restriction breaks something; the effect is stated.

| Frame class | Default | Effect / rationale |
|-------------|---------|--------------------|
| Known unicast to remote MAC | Forward | Normal. |
| Known unicast to local MAC | Not forwarded | Normal bridge behaviour; saves link capacity. |
| Unknown unicast | Forward (flood) | Required for correctness; ageing ≥ host ARP/ND timeouts; counted. |
| Broadcast | Forward, rate-limited (configurable, e.g. 1–5 kpps) | Storm control; too low ⇒ ARP loss in mass reboots. |
| Link-local multicast: IPv4 224.0.0.0/24, IPv6 ff02::/16 (ND, VRRP, OSPF, mDNS) | Forward, rate-limited | IPv6 needs ND. |
| Routable multicast | Forward, rate-limited; IGMP/MLD snooping evaluated in Phase 3 | Snooping with wrong querier ⇒ multicast loss. |
| DHCP | Forward (option: block if one server per site) | Q-D. |
| IPv6 RA | Forward (option: RA-guard per direction) | Q-D. |
| STP BPDU (01:80:C2:00:00:00) | **Drop + alarm** (option: transparent) | See below. |
| PAUSE (…:01) | Never forwarded | NIC consumes. |
| LACP/slow protocols (…:02) | Drop | Must not cross. |
| EAPOL from LAN (…:03) | Drop | Also avoids confusing our own MKA on the link. |
| LLDP (…:0E) | Drop (option: forward) | Leaks inventory, makes switches neighbours across the link. |
| Other 01:80:C2:00:00:0x | Drop | Link-local. |
| VLANs | Allowlist | Unlisted VLANs dropped. |
| 802.1ad / double tags | Drop unless enabled | Anti VLAN-hopping. |
| Other EtherTypes | Default forward (denylist mode); optional allowlist mode | Allowlist breaks PTP, PROFINET, FCoE, MPLS, etc. Q-D. |
| Oversize frames | Drop + count | Link MTU sized to prevent this. |
| Multicast/zero source MAC | Drop | Invalid. |

**STP modes:** *Isolated* (default) — each site its own STP domain; a second L2
path between sites would form an undetected loop, limited by storm control.
*Transparent* — bridge STP off, BPDUs forwarded; one STP domain across both
sites; only if you have redundant L2 paths between sites. With a 500 m direct
fiber, BPDU latency is not a concern, so transparent mode is more viable here
than over a WAN — Q-D.

**MAC limit:** bridge-wide `fdb_max_learned` [VERIFY kernel]; beyond it, new MACs
are flooded (not dropped) and counted.

**Storm control:** nftables `limit rate` / `tc police`, both directions. Cost
measured in Phase 3.

---

## 10. Key management

### 10.1 Static-CAK MKA (baseline)

| Aspect | Design |
|--------|--------|
| CAK generation | 256-bit from the kernel CSPRNG on an operator workstation or one appliance; CKN random 32 bytes. |
| Distribution | Out-of-band via management (SSH) to both appliances; never over LAN or fiber. |
| Storage | Dev: root-only 0600 file on encrypted partition. Prod: TPM 2.0-sealed, unsealed at boot into wpa_supplicant only. |
| Session keys | SAKs generated by the MKA key server, wrapped with the KEK (AES key wrap), RAM only. |
| SAK rotation | On PN threshold (XPN makes this rare), peer change, and periodically if supported [VERIFY]. |
| CAK rotation | Scheduled (e.g. quarterly) and on suspicion. Hitless rotation requires two concurrent CAs [VERIFY wpa_supplicant]; otherwise a brief (seconds) planned outage. |
| Revocation | Two-node system: replace CAK on both appliances. |
| After reboot | CAK persists; SAKs gone; MKA re-establishes in seconds; no forwarding until secured. |
| Compromised peer / CAK | Replace CAK; re-provision. **All traffic recorded under that CAK can be decrypted** (§10.3). |
| Secrets in management | Never displayed; CLI shows CKN and key fingerprints only. |

### 10.2 Optional: EAP-TLS MKA (M2)

Mutual certificates (small offline CA), CAK derived per session from the TLS
handshake (ECDHE) ⇒ forward secrecy for the CAK layer; revocation by CRL.
Costs: an 802.1X authenticator + EAP server on one appliance, a PKI, more
parser surface (EAP/TLS). Decide via Q-B.

### 10.3 The forward-secrecy caveat (important)

With static CAK, SAKs travel on the fiber wrapped with a key derived from the
CAK. An attacker who records the fiber and later obtains the CAK can unwrap
every SAK and decrypt everything recorded. Regular CAK rotation limits the
exposure window; EAP-TLS (M2) removes it.

---

## 11. Performance analysis

### 11.1 Wire limits

Per direction, L1 overhead 20 B/frame, MACsec overhead 32 B (with SCI).

| Inner frame (incl. FCS) | LAN pps @10G | On a **10G** link: max LAN rate | On a **25G** link |
|--|--|--|--|
| 64 B | 14.88 Mpps | 72 % | ≥ 100 % |
| 128 B | 8.45 Mpps | 82 % | ≥ 100 % |
| IMIX (avg 362 B) | 3.27 Mpps | 92 % | ≥ 100 % |
| 512 B | 2.35 Mpps | 94 % | ≥ 100 % |
| 1518 B | 813 kpps | 98 % | ≥ 100 % |
| 9018 B | 138 kpps | 99.6 % | ≥ 100 % |

**With a 25G link, 10G LAN line rate is physically possible at every frame
size.** Remaining limit is CPU (below). 25G on single-mode fiber at 500 m
costs only the optics price difference.

Latency: 500 m fiber ≈ 2.5 µs; appliance ≈ 5–50 µs each [ESTIMATE].

### 11.2 MTU

Linux sets `macsec0` MTU = `wan0` MTU − 32. Set `wan0` MTU to e.g. 9216 on
both ends ⇒ LAN 1500 + VLAN tags, or LAN jumbo up to ~9150, pass without loss.
No fragmentation problem exists on a link we own.

### 11.3 CPU budget [ESTIMATE]

| Frame | pps/direction | Cycles/pkt (bridge + macsec + GCM) | Cores/direction @ 3.5 GHz |
|-------|---------------|-------------------------------------|---------------------------|
| 1518 B | 0.81 M | ~2,500–5,000 | ~1–1.5 |
| IMIX | 3.3 M | ~2,000–3,500 | ~2–3.5 |
| 64 B | 14.9 M | ~1,500–3,000 | ~7–13 — not realistic in the kernel |

**64-byte line rate with CPU crypto and standard implementations is not
realistic** (no mature DPDK software-MACsec exists). 10G at IMIX/large frames
is realistic *if the work is spread across cores*.

### 11.4 Critical risk: multi-core scaling

- **TX:** LAN RSS spreads flows across CPUs; each CPU encrypts. All CPUs share
  one TX SA, whose PN is taken under a per-SA lock ⇒ contention at high pps
  [measure].
- **RX:** every frame on the fiber is EtherType 0x88E5 with encrypted payload.
  NICs cannot hash on L3/L4 ⇒ probably **one RX queue ⇒ one core decrypts** ⇒
  ceiling ~4–8 Gbit/s at 1500 B [ESTIMATE].
  Mitigations, in order:
  1. NIC RSS on L2 fields (DA/SA, which are the original host MACs and vary)
     [VERIFY E810/ConnectX capability].
  2. RPS, if the flow dissector yields a usable hash for MACsec frames [VERIFY].
  3. Async parallel crypto (`pcrypt`/cryptd) preserving order [VERIFY usable with macsec].
  4. Small XDP program on `wan0` redirecting to CPUs via cpumap by MAC hash
     (≈ 50 lines of C/eBPF; the only custom data-plane code, if needed).
  - Any RX parallelism that reorders frames conflicts with `replay_window 0`;
    options 3 and flow-based 1/2/4 preserve per-flow order but **not global PN
    order** ⇒ may require a small replay window (security trade-off §2.5).
    This is the first thing to measure in Phase 4.

If a single core cannot sustain 10G RX and none of 1–4 is acceptable, the
honest outcome is: 10G requires hardware offload or a different design. I'll
bring that to you with measurements before changing anything.

### 11.5 Other resources

Memory bandwidth (~10 GB/s worst case vs 60+ GB/s available), PCIe (2×25G ≈
PCIe 4.0 x8), NUMA (single socket) — not constraints. No user-space transitions
or copies in the data plane.

---

## 12. Component requirements (Phase 1 level)

| Qty | Component | Requirement |
|-----|-----------|-------------|
| 2 | CPU | x86-64, VAES, 8–16 homogeneous cores, high clock |
| 2 | Board | server µATX, ECC, TPM 2.0 header, PCIe x8+, onboard mgmt NIC, BMC isolatable |
| 2 | RAM | 2×16 GB DDR5 ECC |
| 2 | NIC | Intel E810-XXVDA2 (preferred) / X710-DA2 / ConnectX-5/6 Lx |
| 2+2 | Optics (link) | 25GBASE-LR or 10GBASE-LR SFP28/SFP+ for single-mode (Q-A) |
| 2 | Optics/DAC (LAN) | matching the LAN switches (Q-C) |
| 2 | NVMe boot, TPM module, chassis/PSU | |
| 1 | Traffic generator | 3rd node, 2-port NIC, TRex |
| 1 | Managed switch | VLAN/STP/LLDP, to emulate LANs |

---

## 13. Major risks

| # | Risk | Mitigation |
|---|------|-----------|
| R1 | Single-queue MACsec RX limits throughput < 10G | §11.4, measure first in Phase 4 |
| R2 | Kernel MACsec software path less optimised than IPsec | Early benchmark; kernel version selection |
| R3 | No forward secrecy (static CAK) | CAK rotation; M2 (EAP-TLS) |
| R4 | wpa_supplicant MKA feature gaps (XPN, hitless CAK rotation, periodic rekey) | [VERIFY]; version pinning |
| R5 | Replay window vs RX parallelism trade-off | Measure; prefer order-preserving mitigation |
| R6 | Host MACs visible on fiber | Accept or M4 |
| R7 | 64-byte line rate unattainable with CPU crypto | Clarify target (Q-E) |
| R8 | Multimode fiber out of spec at 500 m | Q-A |
| R9 | Loops/storms across sites | BPDU policy, storm control |
| R10 | Compromised peer = L2 access | Inherent; document; L2 guards |
| R11 | BMC / firmware vulnerabilities | Disable/isolate BMC |

---

## 14. Open questions

- **Q-A Fiber type:** single-mode (OS2) or multimode (OM3/OM4)? How many strands?
  Could the link run at 25G?
- **Q-B Forward secrecy:** Is static-CAK MKA (no forward secrecy, rotate CAK
  regularly) acceptable, or is forward secrecy required (⇒ M2, EAP-TLS)?
- **Q-C MAC visibility and LAN side:** Is it acceptable that LAN host MAC
  addresses are visible on the fiber? What are the LAN ports (SFP+ fiber/DAC,
  10GBASE-T copper)?
- **Q-D LAN traffic / policy:** VLAN trunk or untagged (which VLANs)? Jumbo? STP
  on the switches and any other L2 path between the sites? Must LLDP/LACP/PTP/
  other non-IP protocols pass? DHCP per site or shared? Multicast applications?
- **Q-E Definition of 10 Gbit/s:** per direction, which traffic mix? Is 64-byte
  line rate required (not realistic with CPU crypto, §11.3)?
- **Q-F Production:** quantity, environment (rack/office/industrial), budget, lifecycle.
- **Q-G Management:** separate management port acceptable? Remote management path?
  Existing monitoring/syslog?

## Next steps

1. Answer Q-A…Q-G; confirm M1 (MACsec + MKA static CAK), the L2 defaults (§9),
   and development hardware P1 + traffic generator.
2. Phase 2: exact BOM with part numbers and verified prices.
3. Phase 3: plain bridge `LAN ↔ Linux ↔ link` bring-up + baseline measurements
   (unencrypted), then Phase 4 MACsec with static SAKs (M3) for testing, then MKA.
