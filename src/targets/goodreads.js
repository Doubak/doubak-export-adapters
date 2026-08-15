/**
 * canonical → Goodreads 的导入 CSV。
 *
 * ## 只有 ISBN 说了算
 *
 * Goodreads 的 API 在 2020 年关掉了，CSV 上传是**唯一**的进出口。而它的匹配基本
 * 只认 ISBN——书名是中文的，作者名也是中文的，两个都帮不上忙。
 *
 * 实测这份档案 145 本书**全部**有 ISBN（豆瓣的图书详情页必带这一行）。
 * 三个目标平台里，这是覆盖率最高、最不会出岔子的一个。
 *
 * ## 列的形状照 `rwalle/douban-export` 的 14 列走
 *
 * `Title, Author, ISBN, My Rating, Average Rating, Publisher, Binding,
 *  Year Published, Original Publication Year, Date Read, Date Added,
 *  Shelves, Bookshelves, My Review`
 *
 * 那个工具是真的对着 Goodreads 跑过的；这里没有第二份实测，所以照抄一个被用过的
 * 形状，比照着 Goodreads 自己的导出格式（列多得多）另拟一个更稳妥。
 *
 * ## 三个字段故意留空
 *
 * - **Average Rating**：那是 Goodreads 自己的全站均分，不是用户的东西。写进去等于
 *   拿档案里的数字去覆盖人家的。
 * - **Original Publication Year**：档案里没有。豆瓣的「出版年」是**这一版**的年份。
 * - **Binding**：豆瓣写「平装 / 精装」，Goodreads 要 `Paperback / Hardcover`。
 *   翻译得出来，但 ISBN 已经把版本钉死了，这一列只会在冲突时添乱。
 *
 * ## 「读过」才写 `Date Read`
 *
 * 豆瓣的 `marked_at` 是**标记那一天**，不是读完那一天——想读的那 82 本也有日期。
 * 全都写进 `Date Read`，就是替用户宣称他读完了 82 本没读过的书。
 * 所以：`Date Added` 三种状态都写，`Date Read` 只有「读过」写。
 */

import { csv } from '../csv.js';
import { fieldsOf } from '../canonical.js';
import { classify, identifiers } from '../classify.js';

const HEADER = [
  'Title', 'Author', 'ISBN', 'My Rating', 'Average Rating', 'Publisher', 'Binding',
  'Year Published', 'Original Publication Year', 'Date Read', 'Date Added',
  'Shelves', 'Bookshelves', 'My Review',
];
const CHECK_HEADER = ['Title', 'Author', 'DoubanURL', 'Why'];

/** canonical 的状态 → Goodreads 的三个互斥书架。 */
const SHELF = { wish: 'to-read', doing: 'currently-reading', done: 'read' };

/** `marked_at` → `YYYY/MM/DD`，Goodreads 自己导出用的格式。 */
function gDate(markedAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(markedAt?.raw ?? markedAt?.iso ?? ''));
  return m ? `${m[1]}/${m[2]}/${m[3]}` : '';
}

/**
 * @param {ReturnType<import('../canonical.js').loadCanonical>} data
 * @returns {{files: {name: string, text: string}[], report: object}}
 */
export function buildGoodreads(data) {
  const rows = [];
  const needsCheck = [];
  const report = { books: 0, read: 0, reading: 0, toRead: 0, skippedOther: 0, noIsbn: 0 };

  for (const mark of data.marks) {
    const subject = data.subjectOf(mark);
    const sf = subject ? fieldsOf(subject) : null;
    if (classify(mark.medium, sf).category !== 'book') {
      report.skippedOther += 1;
      continue;
    }

    const f = fieldsOf(mark);
    const ids = identifiers(sf);
    const info = sf?.info ?? {};
    const title = sf?.title ?? '';
    const author = (info['作者'] ?? []).join(', ');

    if (!ids.isbn) {
      report.noIsbn += 1;
      needsCheck.push([title, author, mark.subject?.url ?? '', '没有 ISBN，Goodreads 基本匹配不上']);
    }

    rows.push([
      title,
      author,
      ids.isbn ?? '',
      f.rating ?? '', // 豆瓣 1–5 星 = Goodreads 1–5 星，不换算
      '', // Average Rating
      (info['出版社'] ?? [])[0] ?? '',
      '', // Binding
      ids.year ?? '',
      '', // Original Publication Year
      f.status === 'done' ? gDate(f.marked_at) : '',
      gDate(f.marked_at),
      SHELF[f.status] ?? '',
      (f.tags ?? []).join(', '),
      f.comment ?? '',
    ]);
    report.books += 1;
    if (f.status === 'done') report.read += 1;
    else if (f.status === 'doing') report.reading += 1;
    else report.toRead += 1;
  }

  const files = [];
  if (rows.length) files.push({ name: 'goodreads.csv', text: csv(HEADER, rows) });
  if (needsCheck.length) {
    files.push({ name: 'goodreads-needs-check.csv', text: csv(CHECK_HEADER, needsCheck) });
  }
  return { files, report };
}
