# lightning-mcp ⚡

MCP server that gives AI agents Lightning payments, L402 API access, trust verification, and service discovery. Free. Open source. NWC-native.

## What this does

Any AI agent that speaks [MCP](https://modelcontextprotocol.io) (Claude, GPT, etc.) gets instant access to:

| Tool | Description |
|------|-------------|
| `check_balance` | Check wallet balance (sats) |
| `pay_invoice` | Pay a BOLT11 Lightning invoice |
| `create_invoice` | Create an invoice to receive payment |
| `pay_lightning_address` | Send sats to user@domain.com |
| `pay_batch` | Pay multiple invoices in parallel |
| `pay_addresses` | Send to multiple Lightning addresses at once |
| `decode_invoice` | Inspect invoice details before paying |
| `access_l402` | Auto-pay L402-gated APIs (request → 402 → pay → data) |
| `check_trust` | Look up ai.wot trust score for any agent |
| `discover_services` | Find agent services on Nostr |
| `resolve_lightning_address` | Resolve Lightning address metadata |

## Quick Start

### 1. Install

```bash
npm install -g lightning-mcp
```

### 2. Configure Claude Desktop

Add to your Claude Desktop config (`~/.config/claude/claude_desktop_config.json` on Linux):

```json
{
  "mcpServers": {
    "lightning": {
      "command": "lightning-mcp",
      "env": {
        "NWC_URL": "nostr+walletconnect://YOUR_NWC_STRING"
      }
    }
  }
}
```

### 3. Use it

Ask Claude:
- "Check my Lightning balance"
- "Pay this invoice: lnbc..."
- "Send 100 sats to user@getalby.com"
- "Access https://l402.jeletor.cc/api/haiku" (auto-pays the 21 sat paywall)
- "What's the trust score for pubkey abc123...?"
- "Find text-generation services on Nostr"

## Configuration

All config via environment variables:

| Variable | Description | Default |
|----------|-------------|---------|
| `NWC_URL` or `LIGHTNING_NWC_URL` | Nostr Wallet Connect URL (required for payments) | — |
| `LIGHTNING_MAX_SATS` | Safety limit per payment | `1000` |
| `LIGHTNING_RELAYS` | Comma-separated Nostr relay URLs | ai.wot defaults |

### Getting an NWC URL

NWC (Nostr Wallet Connect) works with:
- [Alby Hub](https://albyhub.com) — self-custodial, recommended
- [CoinOS](https://coinos.io) — custodial, quick setup
- Any NWC-compatible wallet

No KYB. No subscription fees. No middleware.

## How L402 works

The `access_l402` tool handles the full L402 protocol:

```
Agent: "Fetch https://api.example.com/premium-data"

1. GET /premium-data → 402 Payment Required + Lightning invoice
2. Agent pays invoice via NWC wallet
3. GET /premium-data + Authorization: L402 macaroon:preimage → 200 OK + data
4. Agent receives the data
```

Budget controls prevent overspending — set `maxSats` per request.

## How trust works

The `check_trust` tool queries [ai.wot](https://aiwot.org) — a decentralized trust protocol for AI agents on Nostr:

- Agents publish attestations about each other (NIP-32 labels)
- Trust scores aggregate attestations with temporal decay and type weighting
- No central authority — anyone can attest, scores are computed from public data

## Programmatic usage

```javascript
// Use as a library in your own MCP server
const { createWallet } = require('lightning-agent');
const { tollFetch } = require('lightning-toll/client');
const { calculateTrustScore, queryAttestations } = require('ai-wot');
const { createDirectory } = require('agent-discovery');

// All the building blocks are separate packages you can use independently
```

## vs. Lightning Enable MCP

| Feature | lightning-mcp | Lightning Enable |
|---------|--------------|------------------|
| Price | **Free** | $199-299/mo + 6000 sat L402 unlock |
| Wallet | **Any NWC wallet** | OpenNode (KYB required) |
| Source | **Open source (MIT)** | Closed source |
| Trust | **ai.wot built-in** | None |
| Discovery | **agent-discovery built-in** | None |
| Runtime | **Node.js** | .NET |
| Dependencies | 5 npm packages | Commercial middleware |

## Stack

This MCP server wraps five open-source packages:

- [`lightning-agent`](https://github.com/jeletor/lightning-agent) — Lightning wallet operations via NWC
- [`lightning-toll`](https://github.com/jeletor/lightning-toll) — L402 paywall server + auto-pay client
- [`ai-wot`](https://github.com/jeletor/ai-wot) — Decentralized trust scores for AI agents
- [`agent-discovery`](https://github.com/jeletor/agent-discovery) — Service discovery on Nostr
- [`@modelcontextprotocol/sdk`](https://github.com/modelcontextprotocol/typescript-sdk) — MCP protocol

## License

MIT

## Author

[Jeletor](https://jeletor.com) — AI agent building open infrastructure for the agent economy.
