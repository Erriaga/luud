'use strict';

const crypto = require('crypto');

/* -------------------------------------------------------------
   PIX - geração do "copia e cola" (BR Code) e integração com
   gateways de pagamento.

   Gateways suportados (PIX_GATEWAY):
   - 'mercadopago': API REST do Mercado Pago (QR Code oficial)
   - 'stub':        modo de desenvolvimento/testes, sem cobrança real

   Others gateways (Efí, OpenPix, PagSeguro) podem ser added aqui
   seguindo o mesmo padrão: criar -> consultar -> notificar.
------------------------------------------------------------- */

const MERCADO_PAGO_API = 'https://api.mercadopago.com';

/* ------------------------------------------------------------------
   BR Code (payload Pix "copia e cola")
------------------------------------------------------------------ */
const CRC16_TABLE = (() => {
  const table = new Uint16Array(256);
  for (let i = 0; i < 256; i++) {
    let value = i << 8;
    for (let bit = 0; bit < 8; bit++) {
      value = (value & 0x8000) ? ((value << 1) ^ 0x1021) & 0xffff : (value << 1) & 0xffff;
    }
    table[i] = value;
  }
  return table;
})();

function pixCrc16(payload) {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc = ((crc << 8) & 0xffff) ^ CRC16_TABLE[((crc >> 8) ^ payload.charCodeAt(i)) & 0xff];
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

function tlv(id, value) {
  const text = String(value);
  return `${id}${String(text.length).padStart(2, '0')}${text}`;
}

/**
 * Monta o payload Pix estático (BR Code) usado no modo de testes.
 * Em produção o QR Code oficial vem do gateway de pagamento.
 */
function buildPixPayload({ key, name, city, amount, txid }) {
  const pixKey = String(key || '').trim();
  if (!pixKey) throw new Error('Chave Pix não configurada.');

  const cleanName = String(name || 'LUUD').replace(/[^\x20-\x7E]/g, '').slice(0, 25) || 'LUUD';
  const cleanCity = String(city || 'SAO PAULO').replace(/[^\x20-\x7E]/g, '').slice(0, 15) || 'SAO PAULO';
  const cleanTxid = String(txid || '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || 'LUUD';

  const merchantAccount = tlv('00', 'br.gov.bcb.pix') + tlv('01', pixKey);
  const additionalData = tlv('05', cleanTxid);

  let payload = '';
  payload += tlv('00', '01');
  payload += tlv('26', merchantAccount);
  payload += tlv('52', '0000');
  payload += tlv('53', '986');
  payload += tlv('54', Number(amount).toFixed(2));
  payload += tlv('58', 'BR');
  payload += tlv('59', cleanName);
  payload += tlv('60', cleanCity);
  payload += tlv('62', additionalData);
  payload += '6304';

  return payload + pixCrc16(payload);
}

/* ------------------------------------------------------------------
   Mercado Pago
------------------------------------------------------------------ */
async function createMercadoPagoPayment({ token, amount, description, email, externalReference, notificationUrl, metadata }) {
  const response = await fetch(`${MERCADO_PAGO_API}/v1/payments`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': String(externalReference)
    },
    body: JSON.stringify({
      transaction_amount: Number(amount),
      payment_method_id: 'pix',
      description: String(description).slice(0, 120),
      payer: { email: String(email || '') },
      external_reference: String(externalReference),
      notification_url: notificationUrl ? String(notificationUrl) : undefined,
      metadata: metadata || {}
    })
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = (data && data.message) || (data && data.cause && data.cause[0] && data.cause[0].description) || 'Falha ao criar a cobrança Pix.';
    throw new Error(message);
  }

  const transaction = (data.point_of_interaction && data.point_of_interaction.transaction_data) || {};
  return {
    id: data.id,
    status: data.status || 'pending',
    qrCode: transaction.qr_code || '',      // imagem PNG em base64 (data URI)
    copyPaste: transaction.qr_code_base64 || '', // payload "copia e cola"
    raw: data
  };
}

async function getMercadoPagoPayment({ token, paymentId }) {
  const response = await fetch(`${MERCADO_PAGO_API}/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { Authorization: `Bearer ${token}` }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return null;
  return data;
}

/**
 * Confere a assinatura do webhook do Mercado Pago
 * (headers x-signature, x-request-id e o segredo da conta).
 */
function verifyMercadoPagoSignature({ secret, signatureHeader, requestId, paymentId }) {
  if (!secret) return true; // sem segredo configurado, não há o que conferir
  if (!signatureHeader || !requestId) return false;

  const parts = String(signatureHeader).split(',');
  const values = {};
  parts.forEach(part => {
    const [key, value] = part.split('=');
    if (key && value) values[key.trim()] = value.trim();
  });

  if (!values.ts || !values.v1) return false;
  const manifest = `id:${paymentId};request-id:${requestId};ts:${values.ts};`;
  const expected = crypto.createHmac('sha256', String(secret)).update(manifest).digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(values.v1, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = {
  buildPixPayload,
  pixCrc16,
  createMercadoPagoPayment,
  getMercadoPagoPayment,
  verifyMercadoPagoSignature
};
