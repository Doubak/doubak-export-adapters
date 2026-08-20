/**
 * 切一小份出来，用于**先拿几条去真平台试一次**。
 *
 * ## 为什么这件事需要一个专门的开关
 *
 * 三个平台的导入都是**不好撤的**：NeoDB 导进去要一条条删，Letterboxd 的观影记录
 * 没有批量撤销，Goodreads 更麻烦。而离线能证明的只是「产出符合从导入器源码里
 * 读出来的格式」，**不是「平台真的收」**——那件事只有真导一次才知道。
 *
 * NeoDB 那一路已经这么验过了（2026-08-20，40 条小样），而它正好印证了这个开关
 * 的必要性：那一次真抓到一处该改的地方（没有豆瓣链接的记录注定失败）。
 * Letterboxd 和 Goodreads 还没验过。
 *
 * 于是有一个很坏的默认路径：想验证一下，就把 2950 条全导进去，然后发现某一列
 * 理解错了。**先拿 20 条试**是唯一负担得起的做法，而如果这件事要用户自己去裁
 * NDJSON，那就等于没提供。
 *
 * ## 按 (分类, 状态) 轮着取，不是取前 N 条
 *
 * 取前 N 条会拿到一堆同类的东西——canonical 是按抓取顺序排的，前 20 条很可能
 * 全是电影、全是「看过」。那样的小样验证不了任何跨类的东西：验不了图书的 ISBN，
 * 验不了「想看」有没有跑进「看过」，验不了舞台剧的链接 NeoDB 认不认。
 *
 * 轮着取则保证**每一种组合都至少来一条**，而这些组合恰好就是最容易出错的地方。
 *
 * 顺序是确定的：同样的输入、同样的 N，切出来的永远是同一批。否则「上次那条有
 * 问题的记录」下次就找不回来了。
 */

import { fieldsOf } from './canonical.js';
import { classify } from './classify.js';

/**
 * @param {ReturnType<import('./canonical.js').loadCanonical>} data
 * @param {number} n 最多留几条标记
 * @returns {ReturnType<import('./canonical.js').loadCanonical>} 同样形状的一份，标记被削过
 */
export function sample(data, n) {
  if (!Number.isInteger(n) || n < 1) throw new Error(`--sample 要一个正整数，收到 ${n}`);

  /** @type {Map<string, object[]>} */
  const buckets = new Map();
  for (const mark of data.marks) {
    const subject = data.subjectOf(mark);
    const { category } = classify(mark.medium, subject ? fieldsOf(subject) : null);
    const key = `${category}:${fieldsOf(mark).status ?? '?'}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(mark);
  }

  // 桶按名字排序，取的顺序才跟 Map 的插入顺序无关。
  const ordered = [...buckets.keys()].sort().map((k) => buckets.get(k));
  const picked = [];
  for (let round = 0; picked.length < n; round += 1) {
    let any = false;
    for (const bucket of ordered) {
      if (round >= bucket.length) continue;
      any = true;
      picked.push(bucket[round]);
      if (picked.length >= n) break;
    }
    if (!any) break; // 档案里的标记比 n 还少
  }

  // 长文和豆列不削。它们本来就只有个位数，而且是**另一条代码路径**——
  // 削掉了小样就验不到书评那张表，而书评表恰好是重复表头那一处。
  const kept = new Set(picked);
  const marks = data.marks.filter((m) => kept.has(m));
  // 「有 N 条标记改过」要按小样重算。照抄全量的数字，说明里就会写着
  // 「这份里有 7 条改过」，而这 20 条里可能一条都没有——一句关于眼前这份文件的
  // 假话，比不说更糟。
  return { ...data, marks, multiRevisionMarks: marks.filter((m) => (m.revisions?.length ?? 0) > 1).length };
}
