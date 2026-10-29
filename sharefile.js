import 'dotenv/config';

const SUBDOMAIN = process.env.SHAREFILE_SUBDOMAIN || ''; 

let token = null;
let tokenExpiresAt = 0;
let apiBase = '';

async function getToken() {
  if (token && Date.now() < tokenExpiresAt - 60_000) return token;

  const res = await fetch(`https://${SUBDOMAIN}.sharefile.com/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'password',
      client_id: process.env.SHAREFILE_CLIENT_ID || '',
      client_secret: process.env.SHAREFILE_CLIENT_SECRET || '',
      username: process.env.SHAREFILE_USERNAME || '',
      password: process.env.SHAREFILE_PASSWORD || '',
    }),
  });
  if (!res.ok) throw new Error(`ShareFile auth ${res.status}: ${await res.text()}`);

  const data = await res.json();
  token = data.access_token;
  tokenExpiresAt = Date.now() + data.expires_in * 1000;
  apiBase = `https://${data.subdomain}.sf-api.com/sf/v3`;
  return token;
}

async function sfRequest(path, options = {}) {
  const t = await getToken();
  const res = await fetch(`${apiBase}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${t}`,
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) throw new Error(`ShareFile ${res.status}: ${await res.text()}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}


export async function listChildrenPage(folderId, { page = 1, pageSize = 50 } = {}) {
    const safePage = Math.max(1, Number(page) || 1);
    const safeSize = Math.min(500, Math.max(1, Number(pageSize) || 50));
    const skip = (safePage - 1) * safeSize;
  
    const data = await sfRequest(`/Items(${folderId})/Children?$top=${safeSize}&$skip=${skip}`);
    const items = data?.value || [];
    const total = typeof data?.['odata.count'] === 'number' ? data['odata.count'] : null;
  
    return {
      items,
      page: safePage,
      pageSize: safeSize,
      total,
      hasMore: total !== null ? skip + items.length < total : items.length === safeSize,
    };
  }
  
  export async function listChildren(folderId) {
    const pageSize = 500;
    const all = [];
    let page = 1;
    while (true) {
      const result = await listChildrenPage(folderId, { page, pageSize });
      all.push(...result.items);
      if (!result.hasMore) break;
      page++;
    }
    return all;
  }


export async function downloadFile(itemId) {
  const info = await sfRequest(`/Items(${itemId})/Download?redirect=false`);
  const res = await fetch(info.DownloadUrl);
  if (!res.ok) throw new Error(`ShareFile download ${res.status}`);
  return Buffer.from(await res.arrayBuffer()).toString('base64');
}

export async function moveItem(itemId, newParentId) {
  await sfRequest(`/Items(${itemId})`, {
    method: 'PATCH',
    body: JSON.stringify({ Parent: { Id: newParentId } }),
  });
}

export async function copyItem(itemId, targetFolderId, overwrite = false) {
  return sfRequest(
    `/Items(${itemId})/Copy?targetid=${targetFolderId}&overwrite=${overwrite}`,
    { method: 'POST' }
  );
}

export async function deleteItem(itemId) {
//   await sfRequest(`/Items(${itemId})`, { method: 'DELETE' });
}   


export async function createFolder(parentId, name) {
    return sfRequest(`/Items(${parentId})/Folder?overwrite=false&passthrough=false`, {
      method: 'POST',
      body: JSON.stringify({ Name: name, Description: 'Automatic backup' }),
    });
  }