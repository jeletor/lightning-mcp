#!/usr/bin/env node
'use strict';

const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const z = require('zod');
const { createWallet, decodeBolt11, resolveLightningAddress } = require('lightning-agent');
const { tollFetch } = require('lightning-toll/client');
const { calculateTrustScore, queryAttestations, RELAYS } = require('ai-wot');
const { createDirectory } = require('agent-discovery');

// ---------------------------------------------------------------------------
// Config — from env vars
// ---------------------------------------------------------------------------

const NWC_URL = process.env.LIGHTNING_NWC_URL || process.env.NWC_URL || '';
const MAX_SATS = parseInt(process.env.LIGHTNING_MAX_SATS || '1000', 10);
const NOSTR_RELAYS = (process.env.LIGHTNING_RELAYS || '').split(',').filter(Boolean);
const relays = NOSTR_RELAYS.length ? NOSTR_RELAYS : RELAYS;

// ---------------------------------------------------------------------------
// Lazy singletons
// ---------------------------------------------------------------------------

let _wallet = null;
function getWallet() {
  if (!NWC_URL) throw new Error('No wallet configured. Set LIGHTNING_NWC_URL or NWC_URL env var.');
  if (!_wallet) _wallet = createWallet(NWC_URL);
  return _wallet;
}

let _directory = null;
function getDirectory() {
  if (!_directory) _directory = createDirectory({ relays });
  return _directory;
}

// ---------------------------------------------------------------------------
// MCP Server
// ---------------------------------------------------------------------------

const server = new McpServer({
  name: 'lightning-mcp',
  version: '0.1.0',
}, {
  capabilities: {
    tools: {}
  }
});

// ---- check_balance --------------------------------------------------------

server.registerTool(
  'check_balance',
  {
    title: 'Check Lightning Wallet Balance',
    description: 'Check the current balance of the connected Lightning wallet (in sats).',
    inputSchema: {}
  },
  async () => {
    try {
      const wallet = getWallet();
      const result = await wallet.getBalance();
      const sats = result.balanceSats ?? result.balance ?? 0;
      return {
        content: [{ type: 'text', text: JSON.stringify({ balanceSats: sats }, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ---- pay_invoice ----------------------------------------------------------

server.registerTool(
  'pay_invoice',
  {
    title: 'Pay Lightning Invoice',
    description: 'Pay a BOLT11 Lightning invoice. Returns the payment preimage on success.',
    inputSchema: {
      invoice: z.string().describe('BOLT11 Lightning invoice string (starts with lnbc…)'),
      maxSats: z.number().optional().describe('Maximum sats to pay (safety limit). Defaults to LIGHTNING_MAX_SATS env or 1000.')
    }
  },
  async ({ invoice, maxSats }) => {
    try {
      const wallet = getWallet();
      const limit = maxSats || MAX_SATS;

      // Decode first to check amount
      let decoded;
      try {
        decoded = decodeBolt11(invoice);
      } catch { /* some invoices may not decode locally */ }

      if (decoded && decoded.satoshis && decoded.satoshis > limit) {
        return {
          content: [{ type: 'text', text: `Refused: invoice amount ${decoded.satoshis} sats exceeds safety limit of ${limit} sats.` }],
          isError: true
        };
      }

      const result = await wallet.payInvoice(invoice);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            preimage: result.preimage,
            ...(decoded?.satoshis ? { amountSats: decoded.satoshis } : {})
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Payment failed: ${err.message}` }], isError: true };
    }
  }
);

// ---- create_invoice -------------------------------------------------------

server.registerTool(
  'create_invoice',
  {
    title: 'Create Lightning Invoice',
    description: 'Create a Lightning invoice to receive a payment.',
    inputSchema: {
      amountSats: z.number().int().positive().describe('Amount in satoshis'),
      description: z.string().optional().describe('Invoice description / memo')
    }
  },
  async ({ amountSats, description }) => {
    try {
      const wallet = getWallet();
      const result = await wallet.createInvoice({
        amount: amountSats,
        description: description || `lightning-mcp invoice for ${amountSats} sats`
      });
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            invoice: result.invoice,
            paymentHash: result.payment_hash || result.paymentHash,
            amountSats
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error creating invoice: ${err.message}` }], isError: true };
    }
  }
);

// ---- pay_lightning_address -------------------------------------------------

server.registerTool(
  'pay_lightning_address',
  {
    title: 'Pay Lightning Address',
    description: 'Pay a Lightning address (user@domain.com format). Resolves the address, creates an invoice, and pays it.',
    inputSchema: {
      address: z.string().describe('Lightning address (e.g. user@getalby.com)'),
      amountSats: z.number().int().positive().describe('Amount in satoshis to send'),
      maxSats: z.number().optional().describe('Maximum sats safety limit')
    }
  },
  async ({ address, amountSats, maxSats }) => {
    try {
      const wallet = getWallet();
      const limit = maxSats || MAX_SATS;
      if (amountSats > limit) {
        return {
          content: [{ type: 'text', text: `Refused: ${amountSats} sats exceeds safety limit of ${limit} sats.` }],
          isError: true
        };
      }
      const result = await wallet.payAddress(address, amountSats);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            success: true,
            address,
            amountSats,
            preimage: result.preimage
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ---- decode_invoice -------------------------------------------------------

server.registerTool(
  'decode_invoice',
  {
    title: 'Decode Lightning Invoice',
    description: 'Decode a BOLT11 invoice to inspect its amount, description, expiry, and payment hash.',
    inputSchema: {
      invoice: z.string().describe('BOLT11 Lightning invoice to decode')
    }
  },
  async ({ invoice }) => {
    try {
      const decoded = decodeBolt11(invoice);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            amountSats: decoded.satoshis || null,
            description: decoded.description || null,
            paymentHash: decoded.tags?.find(t => t.tagName === 'payment_hash')?.data || null,
            expirySeconds: decoded.timeExpireDate
              ? decoded.timeExpireDate - decoded.timestamp
              : null,
            timestamp: decoded.timestamp,
            payee: decoded.payeeNodeKey || null
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Decode error: ${err.message}` }], isError: true };
    }
  }
);

// ---- access_l402 ----------------------------------------------------------

server.registerTool(
  'access_l402',
  {
    title: 'Access L402-Protected API',
    description: 'Fetch a URL that may be behind an L402 (Lightning-gated) paywall. Automatically pays the invoice and retries with proof of payment. Returns the response data.',
    inputSchema: {
      url: z.string().url().describe('URL to fetch (may return 402 with Lightning invoice)'),
      method: z.enum(['GET', 'POST', 'PUT', 'DELETE']).optional().describe('HTTP method (default GET)'),
      body: z.string().optional().describe('Request body (for POST/PUT)'),
      headers: z.record(z.string()).optional().describe('Additional request headers'),
      maxSats: z.number().optional().describe('Maximum sats to auto-pay (safety limit)'),
      nostrPubkey: z.string().optional().describe('Your Nostr pubkey hex for trust discounts (X-Nostr-Pubkey header)')
    }
  },
  async ({ url, method, body, headers, maxSats, nostrPubkey }) => {
    try {
      const wallet = getWallet();
      const limit = maxSats || MAX_SATS;
      const reqHeaders = { ...(headers || {}) };
      if (nostrPubkey) reqHeaders['X-Nostr-Pubkey'] = nostrPubkey;

      const fetchOpts = {
        method: method || 'GET',
        headers: reqHeaders
      };
      if (body && (method === 'POST' || method === 'PUT')) {
        fetchOpts.body = body;
        if (!reqHeaders['Content-Type']) reqHeaders['Content-Type'] = 'application/json';
      }

      const res = await tollFetch(url, fetchOpts, { wallet, maxSats: limit });

      const contentType = res.headers?.get?.('content-type') || '';
      let responseBody;
      if (contentType.includes('application/json')) {
        responseBody = await res.json();
      } else {
        responseBody = await res.text();
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            status: res.status,
            paid: res.status === 200,
            data: responseBody
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `L402 error: ${err.message}` }], isError: true };
    }
  }
);

// ---- check_trust ----------------------------------------------------------

server.registerTool(
  'check_trust',
  {
    title: 'Check Agent Trust Score (ai.wot)',
    description: 'Look up the ai.wot (Web of Trust) trust score for a Nostr pubkey. Returns trust score (0-100), attestation count, and attester info.',
    inputSchema: {
      pubkey: z.string().describe('Nostr public key (hex) to look up')
    }
  },
  async ({ pubkey }) => {
    try {
      const attestations = await queryAttestations(pubkey, relays);
      const result = await calculateTrustScore(attestations, new Map(), { maxDepth: 0 });
      const summary = {
        pubkey,
        trustScore: result.display,
        rawScore: Math.round(result.raw * 100) / 100,
        attestationCount: result.attestationCount || attestations.length,
        attesters: [...new Set(attestations.map(a => a.pubkey))].length,
        diversity: result.diversity || null,
        types: {}
      };
      for (const a of attestations) {
        const type = a.tags?.find(t => t[0] === 'l' && t[2] === 'ai.wot')?.[1] || 'unknown';
        summary.types[type] = (summary.types[type] || 0) + 1;
      }
      return {
        content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Trust lookup error: ${err.message}` }], isError: true };
    }
  }
);

// ---- discover_services ----------------------------------------------------

server.registerTool(
  'discover_services',
  {
    title: 'Discover Agent Services',
    description: 'Search for agent services on Nostr using decentralized service discovery. Filter by capability (e.g. "text-generation", "translation", "image-generation").',
    inputSchema: {
      capability: z.string().optional().describe('Filter by capability tag (e.g. "text-generation", "translation")'),
      limit: z.number().optional().describe('Maximum results to return (default 10)')
    }
  },
  async ({ capability, limit }) => {
    try {
      const dir = getDirectory();
      const opts = {};
      if (capability) opts.capabilities = [capability];
      if (limit) opts.limit = limit;
      const services = await dir.find(opts);
      const results = services.map(s => ({
        name: s.name || s.display_name || 'Unknown',
        pubkey: s.pubkey?.slice(0, 16) + '…',
        capabilities: s.capabilities || [],
        price: s.price || null,
        lightningAddress: s.lightning_address || s.ln || null,
        status: s.status || 'unknown'
      }));
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({ found: results.length, services: results }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Discovery error: ${err.message}` }], isError: true };
    }
  }
);

// ---- resolve_lightning_address --------------------------------------------

server.registerTool(
  'resolve_lightning_address',
  {
    title: 'Resolve Lightning Address',
    description: 'Resolve a Lightning address (user@domain.com) to get LNURL metadata, min/max sendable amounts, and callback URL.',
    inputSchema: {
      address: z.string().describe('Lightning address (e.g. user@getalby.com)')
    }
  },
  async ({ address }) => {
    try {
      const result = await resolveLightningAddress(address);
      return {
        content: [{
          type: 'text',
          text: JSON.stringify({
            address,
            callback: result.callback,
            minSendable: Math.ceil(result.minSendable / 1000),
            maxSendable: Math.floor(result.maxSendable / 1000),
            description: result.metadata ? JSON.parse(result.metadata)?.[0]?.[1] : null,
            tag: result.tag
          }, null, 2)
        }]
      };
    } catch (err) {
      return { content: [{ type: 'text', text: `Resolve error: ${err.message}` }], isError: true };
    }
  }
);

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write('lightning-mcp server running on stdio\n');
}

main().catch(err => {
  process.stderr.write(`Fatal: ${err.message}\n`);
  process.exit(1);
});
