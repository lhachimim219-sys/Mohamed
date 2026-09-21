// أدوات طلبات HTTP مع إعادة المحاولة (تعمل بـ fetch المدمج في Node 18+)
const UA =
  'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, { headers = {}, retries = 3, timeout = 30000, method = 'GET', body } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(url, {
        method,
        body,
        headers: { 'User-Agent': UA, ...headers },
        signal: AbortSignal.timeout(timeout),
        redirect: 'follow',
      });
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status}`);
        // أخطاء لا فائدة من إعادة المحاولة فيها
        if ([400, 401, 403, 404, 410].includes(res.status)) err.noRetry = true;
        throw err;
      }
      return res;
    } catch (e) {
      lastErr = e;
      if (e.noRetry) break;
      if (i < retries) await sleep(800 * (i + 1));
    }
  }
  throw new Error(`فشل الطلب: ${url} (${lastErr?.message})`);
}

export async function getBuffer(url, opts) {
  const res = await request(url, opts);
  return Buffer.from(await res.arrayBuffer());
}

export async function getText(url, opts) {
  return (await request(url, opts)).text();
}

export async function getJson(url, opts) {
  return (await request(url, opts)).json();
}

// طلب POST (مثلاً لقوالب Madara: /ajax/chapters/)
export async function postText(url, body = '', opts = {}) {
  const res = await request(url, {
    ...opts,
    method: 'POST',
    body,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...(opts.headers || {}) },
  });
  return res.text();
}
