// Métricas puras do Instagram (F6).
//
// Interações de um post = total_interactions (quando a API devolve) ou, na falta,
// likes + comentários + salvos + compartilhamentos (os que existirem).
// Taxa de engajamento = interações / alcance do post (reach). Sem alcance (conta sem insights,
// plano Free), usa interações / seguidores. Arredondada a 4 casas (0.0532 = 5,32%).
// Taxa da conta = soma das interações / soma dos alcances dos posts considerados
// (ou / (seguidores × nº de posts) quando faltam alcances).
const num = value => (value === null || value === undefined || !Number.isFinite(Number(value)) ? null : Number(value));
const round = value => (value === null ? null : Math.round(value * 10000) / 10000);

function interactions(post) {
  const total = num(post.total_interactions);
  if (total !== null) return total;
  const parts = [post.like_count, post.comments_count, post.saved, post.shares].map(num).filter(value => value !== null);
  return parts.length ? parts.reduce((a, b) => a + b, 0) : null;
}

function engagement(post, followers) {
  const inter = interactions(post);
  if (inter === null) return { interactions: null, engagement_rate: null, engagement_basis: null };
  const reach = num(post.reach);
  if (reach && reach > 0) return { interactions: inter, engagement_rate: round(inter / reach), engagement_basis: 'reach' };
  const base = num(followers);
  if (base && base > 0) return { interactions: inter, engagement_rate: round(inter / base), engagement_basis: 'followers' };
  return { interactions: inter, engagement_rate: null, engagement_basis: null };
}

function summary(posts, followers) {
  let inter = 0; let reach = 0; let counted = 0; let withReach = 0;
  for (const post of posts) {
    const value = interactions(post);
    if (value === null) continue;
    counted += 1; inter += value;
    if (num(post.reach) > 0) { reach += Number(post.reach); withReach += 1; }
  }
  if (!counted) return { posts_considered: 0, interactions: 0, avg_interactions: null, engagement_rate: null, engagement_basis: null };
  let rate = null; let basis = null;
  if (withReach === counted && reach > 0) { rate = inter / reach; basis = 'reach'; } else if (num(followers) > 0) { rate = inter / (Number(followers) * counted); basis = 'followers'; }
  return { posts_considered: counted, interactions: inter, avg_interactions: round(inter / counted), engagement_rate: round(rate), engagement_basis: basis };
}

// Comparativo (Premium): ranking por taxa de engajamento e média por tipo de mídia.
function compare(posts, followers) {
  const enriched = posts.map(post => ({ ...post, ...engagement(post, followers) }));
  const ranked = enriched.filter(post => post.engagement_rate !== null).sort((a, b) => b.engagement_rate - a.engagement_rate);
  const byType = {};
  for (const post of enriched) {
    const type = post.media_product_type === 'REELS' ? 'REELS' : (post.media_type || 'OTHER');
    (byType[type] ||= []).push(post);
  }
  const by_type = Object.entries(byType).map(([type, list]) => ({ type, ...summary(list, followers) }));
  return { top: ranked.slice(0, 3).map(post => post.media_id), bottom: ranked.slice(-3).reverse().map(post => post.media_id), by_type };
}

// Funil de conversão (Premium): visitas -> agendamentos -> receita.
function funnel({ visits = 0, bookings = 0, revenue_estimated_cents = 0, revenue_paid_cents = 0, profile_links_taps = null }) {
  const rate = (a, b) => (b > 0 ? round(a / b) : null);
  return {
    profile_links_taps,
    visits,
    bookings,
    visit_to_booking_rate: rate(bookings, visits),
    revenue_estimated_cents,
    revenue_paid_cents,
  };
}

module.exports = { interactions, engagement, summary, compare, funnel };
