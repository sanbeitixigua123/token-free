/**
 * search.js — 中英文统一检索
 *
 * 背景：SQLite 的 unicode61 分词器把连续中文视作单个 token，
 *       因此 "1亿" 无法命中正文里的 "1 亿 Token"。
 * 策略：双路合并
 *   A) FTS5 前缀匹配 —— 英文/单词类查询很快
 *   B) LIKE 子串回退 —— 中文子串、数字+汉字混排（如 "1亿"）
 * 两路结果按 rowid 去重，FTS 命中优先级更高。
 */

const CJK = /[\u4e00-\u9fff]/;

/** 把用户输入切成可用的 FTS 词（转义引号，加前缀通配） */
function toFtsQuery(q) {
  const words = String(q)
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.replace(/["*]/g, ''))
    .filter(Boolean);
  if (!words.length) return null;
  return words.map((w) => `"${w}"*`).join(' AND ');
}

/**
 * 返回匹配的 activity id 集合，或 null（表示"未做关键词过滤"，即匹配全部）。
 * @param {object} db
 * @param {string} q 关键词
 * @returns {number[]|null}
 */
export function searchActivityIds(db, q) {
  const query = (q || '').trim();
  if (!query) return null;

  const ids = new Set();

  // A) FTS
  const fts = toFtsQuery(query);
  if (fts) {
    try {
      const rows = db.prepare('SELECT rowid FROM activities_fts WHERE activities_fts MATCH ?').all(fts);
      rows.forEach((r) => ids.add(Number(r.rowid)));
    } catch { /* 查询语法问题则跳过 FTS 路径 */ }
  }

  // B) LIKE 子串回退（中文/混排必须）
  const like = `%${query.replace(/[%_]/g, (m) => '\\' + m)}%`;
  try {
    const rows = db
      .prepare(
        `SELECT a.id FROM activities a
         JOIN providers p ON p.id = a.provider_id
         WHERE a.title LIKE ? ESCAPE '\\'
            OR a.summary LIKE ? ESCAPE '\\'
            OR a.benefit_text LIKE ? ESCAPE '\\'
            OR a.audience_note LIKE ? ESCAPE '\\'
            OR p.name_zh LIKE ? ESCAPE '\\'
            OR p.name_en LIKE ? ESCAPE '\\'`
      )
      .all(like, like, like, like, like, like);
    rows.forEach((r) => ids.add(Number(r.id)));
  } catch { /* ignore */ }

  // 兜底：FTS 也可能因为分词得到 0 结果，此处仍返回已收集集合
  return [...ids];
}

export { CJK };
