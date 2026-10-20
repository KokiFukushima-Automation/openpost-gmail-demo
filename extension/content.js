(async () => {
  const {threadId, matchRows} = await import(chrome.runtime.getURL('matcher.js'));
  let busy = false;
  let timer;
  let root;
  let observer;
  const clear = () => document.querySelectorAll('.openpost-signal').forEach(el => el.remove());
  async function refresh() {
    if (busy || document.hidden) return;
    busy = true;
    try {
      const main = document.querySelector('[role="main"]');
      if (!main) { clear(); return; }
      if (root !== main) {
        observer?.disconnect(); root = main;
        observer = new MutationObserver(changes => {
          if (changes.some(change => !change.target.closest?.('.openpost-signal') &&
              (change.type !== 'childList' || [...change.addedNodes, ...change.removedNodes].some(node => !node.classList?.contains('openpost-signal'))))) {
            clear();
            clearTimeout(timer); timer = setTimeout(refresh, 500);
          }
        });
        observer.observe(root, {childList:true, subtree:true,characterData:true,attributes:true,attributeFilter:['data-legacy-thread-id','data-thread-id']});
      }
      const nodes = [...main.querySelectorAll('[data-legacy-thread-id], [data-thread-id]')];
      const rows = [];
      const hosts = new Map();
      const sources = new Map();
      for (const node of nodes) {
        const id = threadId(node.getAttribute('data-legacy-thread-id') ?? node.getAttribute('data-thread-id'));
        const host = node.closest('tr')?.querySelector('.bog') ?? (node.matches('h2') ? node : null);
        if (!id || !host || [...hosts.values()].includes(host)) continue;
        const rowId = String(rows.length); hosts.set(rowId,host); sources.set(rowId,{node,id}); rows.push({rowId,threadId:id});
      }
      const results = [];
      for (let i=0; i<rows.length; i+=100) {
        const response = await chrome.runtime.sendMessage({type:'lookup',threadIds:[...new Set(rows.slice(i,i+100).map(r => r.threadId))]});
        if (response?.error) throw new Error(response.error);
        results.push(...(response?.results ?? []));
      }
      // Clear on every response, including revoked credentials and unmatched virtualized rows.
      clear();
      for (const badge of matchRows(rows,results)) {
        const host = hosts.get(badge.rowId);
        const source = sources.get(badge.rowId);
        const currentId = threadId(source.node.getAttribute('data-legacy-thread-id') ?? source.node.getAttribute('data-thread-id'));
        if (!host?.isConnected || !source.node.isConnected || currentId !== source.id) continue;
        const span = document.createElement('span');
        span.className = 'openpost-signal'; span.textContent = badge.glyph;
        span.title = badge.title; span.setAttribute('aria-label',badge.title);
        host.append(span);
      }
    } catch { clear(); }
    finally {busy=false;}
  }
  chrome.storage.onChanged.addListener(() => {clear(); refresh();});
  window.addEventListener('hashchange', () => {clear(); refresh();});
  document.addEventListener('visibilitychange',refresh);
  setInterval(refresh, 30000);
  await refresh();
})();
