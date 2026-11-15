const axios = require('axios');
const functions = require('../utils/functions');
const plans = require('./plansService');
const tokens = require('./publicTokens');
const { whatsappNumber } = require('./notificationService');

// Handlers de jobs da F3 (fila em banco; drenados por tick/drainSoon, sem processo sempre ligado).
// Nunca registram telefone, e-mail ou nome em log.

async function sendWhatsapp(number, text) {
  if (!process.env.WHATSAPP_API_URL || !process.env.WHATSAPP_OUTBOUND_TOKEN) {
    throw new Error('WhatsApp de saída não configurado (WHATSAPP_API_URL/WHATSAPP_OUTBOUND_TOKEN).');
  }
  await axios.post(`${process.env.WHATSAPP_API_URL}/message/sendText`, { number, text }, {
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_OUTBOUND_TOKEN}`, 'Content-Type': 'application/json' }, timeout: 10000,
  });
}

async function sendEmail({ to, subject, text }) {
  if (!process.env.USER_EMAIL || !to) return false;
  const transporter = require('../config/email');
  await transporter.sendMail({ from: process.env.USER_EMAIL, to, subject, text });
  return true;
}

// Lead do site institucional -> equipe comercial (e-mail e/ou WhatsApp configurados por env).
async function leadNotify({ lead_id: leadId }) {
  const [lead] = await functions.executeSql('SELECT id, name, whatsapp, email, segment, source, message, created_at FROM leads WHERE id = ?', [leadId]);
  if (!lead) return { skipped: true };
  const text = [
    'Novo lead no site AgendasPRO',
    `Nome: ${lead.name}`,
    `WhatsApp: ${lead.whatsapp}`,
    lead.email ? `E-mail: ${lead.email}` : null,
    `Segmento: ${lead.segment}`,
    `Origem: ${lead.source}`,
    lead.message ? `Mensagem: ${lead.message}` : null,
  ].filter(Boolean).join('\n');
  const channels = [];
  if (process.env.SALES_NOTIFY_EMAIL) {
    if (await sendEmail({ to: process.env.SALES_NOTIFY_EMAIL, subject: `Novo lead: ${lead.segment}`, text })) channels.push('email');
  }
  if (process.env.SALES_NOTIFY_WHATSAPP) {
    await sendWhatsapp(whatsappNumber(process.env.SALES_NOTIFY_WHATSAPP), text);
    channels.push('whatsapp');
  }
  return channels.length ? { sent: channels } : { skipped: true, reason: 'sem destino configurado' };
}

function manageLink(row) {
  const base = (process.env.PUBLIC_SITE_URL || '').replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/agendamento/${tokens.issue(row.public_id, row.token_expires_at)}`;
}

// Confirmação ao cliente (agendamento sem sinal, sinal pago ou remarcação).
async function bookingConfirmation({ appointment_id: appointmentId, kind = 'confirmed' }) {
  const [row] = await functions.executeSql(`SELECT a.id, a.company_id, a.canceled, a.payment_status, a.hold_expires_at,
      DATE_FORMAT(a.date, '%d/%m') AS day, DATE_FORMAT(a.date, '%H:%i') AS time,
      cu.name AS customer_name, cu.tel, cu.email, cu.anonymized_at, co.name AS company_name, pb.public_id, pb.token_expires_at
    FROM public_bookings pb
    JOIN appointments a ON a.id = pb.appointment_id AND a.company_id = pb.company_id
    JOIN customers cu ON cu.id = a.customer_id AND cu.company_id = a.company_id
    JOIN companies co ON co.id = a.company_id
    WHERE a.id = ?`, [appointmentId]);
  if (!row || Number(row.canceled) === 1 || row.anonymized_at) return { skipped: true };
  if (row.payment_status === 'pendente' || row.hold_expires_at) return { skipped: true, reason: 'aguardando pagamento' };

  const link = manageLink(row);
  const verb = kind === 'rescheduled' ? 'foi remarcado' : 'está confirmado';
  const text = `Olá, ${row.customer_name}! Seu agendamento na *${row.company_name}* ${verb} para *${row.day}* às *${row.time}*.`
    + (link ? `\nPara ver, cancelar ou remarcar: ${link}` : '');
  const sent = [];

  const ent = await plans.entitlement(row.company_id);
  const number = whatsappNumber(row.tel);
  if (ent.features?.whatsapp_confirmation !== false && number.length >= 12) {
    let allowed = true;
    try {
      await plans.assertQuota(row.company_id, 'whatsapp_monthly_messages', { ent });
    } catch (error) {
      if (error?.code !== 'plan_upgrade_required') throw error;
      allowed = false;
    }
    if (allowed) {
      await sendWhatsapp(number, text);
      await plans.incrementUsage(row.company_id, 'whatsapp_monthly_messages').catch(() => {});
      sent.push('whatsapp');
    }
  }
  if (!sent.length && row.email) {
    if (await sendEmail({ to: row.email, subject: `Agendamento ${kind === 'rescheduled' ? 'remarcado' : 'confirmado'} - ${row.company_name}`, text })) sent.push('email');
  }
  return sent.length ? { sent } : { skipped: true, reason: 'sem canal' };
}

module.exports = { leadNotify, bookingConfirmation, manageLink };
