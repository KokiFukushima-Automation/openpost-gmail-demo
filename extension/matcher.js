// Pure matching: never guess a read receipt from a subject or sender name.
export function threadId(value) {
  const id = String(value ?? '').replace(/^#/, '');
  return /^[0-9a-f]{10,32}$/i.test(id) ? id.toLowerCase() : null;
}

const STATES = {
  not_opened: ['○', '開封シグナルなし（未読とは断定できません）'],
  prefetched: ['◐', '先読みのみ・開封は未確認'],
  opened: ['●', '開封の可能性あり'],
  read_confirmed: ['◉', '複数の開封シグナルあり（読了の保証ではありません）'],
  replied: ['↩', '返信あり'],
};

export function matchRows(rows, results) {
  const exact = new Map(results.filter(r => r.matchedBy === 'threadId' && threadId(r.key)).map(r => [threadId(r.key), r]));
  return rows.flatMap(row => {
    const match = exact.get(threadId(row.threadId));
    const state = match?.summary?.state;
    const glyph = Object.hasOwn(STATES, state) ? STATES[state] : null;
    if (!glyph) return [];
    const summary = match.summary;
    return [{rowId: row.rowId, glyph: glyph[0], state,
      title: `openpost: ${glyph[1]} / 開封 ${summary.opens ?? 0}・クリック ${summary.clicks ?? 0} / スレッド単位（宛先全員の既読を意味しません）`}];
  });
}
