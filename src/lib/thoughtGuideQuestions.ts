export interface ThoughtOption {
  key: string;
  text: string;
}

export interface ThoughtQuestion {
  number: number;
  text: string;
  options?: ThoughtOption[];
}

const Q_LINE = /^(\d+)\s*[.．、)）]\s*(.+)$/;
const OPTION_LINE = /^([A-Za-z]|[①-⑩])\s*[.．、)）]\s*(.+)$/;

const CIRCLED_NUM_TO_LETTER: Record<string, string> = {
  "①": "A", "②": "B", "③": "C", "④": "D", "⑤": "E",
  "⑥": "F", "⑦": "G", "⑧": "H", "⑨": "I", "⑩": "J",
};

function normalizeKey(raw: string): string {
  if (CIRCLED_NUM_TO_LETTER[raw]) return CIRCLED_NUM_TO_LETTER[raw];
  return raw.toUpperCase();
}

function extractInlineOptions(text: string): { cleanText: string; options: ThoughtOption[] } {
  // 选项文本可以包含字母（如 `item_no`、SKU 等），所以用 .+? 配合 lookahead 切分，
  // 不能再用负字符类 [^A-Za-z..] —— 那样会在第一个字母处断开。
  const inlineRegex = /([A-Za-z]|[①-⑩])\s*[.．、)）]\s*(.+?)(?=\s+([A-Za-z]|[①-⑩])\s*[.．、)）]|$)/g;
  const opts: ThoughtOption[] = [];
  const matches: { full: string; key: string; text: string }[] = [];
  let m: RegExpExecArray | null;
  while ((m = inlineRegex.exec(text)) !== null) {
    matches.push({ full: m[0], key: normalizeKey(m[1]), text: m[2].trim() });
  }
  if (matches.length >= 2) {
    const seen = new Set<string>();
    for (const it of matches) {
      if (seen.has(it.key)) continue;
      seen.add(it.key);
      opts.push({ key: it.key, text: it.text });
    }
    let cleanText = text;
    for (const it of matches) {
      cleanText = cleanText.replace(it.full, "");
    }
    return { cleanText: cleanText.trim(), options: opts };
  }
  return { cleanText: text, options: [] };
}

export function parseThoughtQuestions(content: string): ThoughtQuestion[] | null {
  if (!content.includes("【关键提问】")) return null;

  const questionBlockMatch = content.match(/【关键提问】[\s\S]*?(?=【提醒】|【行动呼吁】|【诊断反馈】|$)/);
  if (!questionBlockMatch) return null;

  const block = questionBlockMatch[0];
  const lines = block.split("\n").map((l) => l.trimEnd());
  const questions: ThoughtQuestion[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();
    const qMatch = line.match(Q_LINE);
    if (qMatch) {
      const number = parseInt(qMatch[1], 10);
      let text = qMatch[2].trim();
      let options: ThoughtOption[] = [];

      const inline = extractInlineOptions(text);
      if (inline.options.length >= 2) {
        text = inline.cleanText || text;
        options = inline.options;
        i++;
      } else {
        i++;
        while (i < lines.length) {
          const optLine = lines[i].trim();
          // 选项行本身可能也是 "A. xx B. yy C. zz" 这种内联多选项形式，
          // 优先按内联拆分，避免被 OPTION_LINE 整行贪婪吃成单选项。
          const inlineOnLine = extractInlineOptions(optLine);
          if (inlineOnLine.options.length >= 2) {
            for (const o of inlineOnLine.options) {
              if (!options.some((x) => x.key === o.key)) options.push(o);
            }
            i++;
            continue;
          }
          const optMatch = optLine.match(OPTION_LINE);
          if (optMatch) {
            const key = normalizeKey(optMatch[1]);
            if (!options.some((o) => o.key === key)) {
              options.push({ key, text: optMatch[2].trim() });
            }
            i++;
          } else if (optLine === "") {
            i++;
            break;
          } else if (Q_LINE.test(optLine)) {
            break;
          } else {
            if (options.length > 0) break;
            text += "\n" + optLine;
            i++;
          }
        }
      }

      questions.push({ number, text, options: options.length > 0 ? options : undefined });
    } else {
      i++;
    }
  }

  return questions.length > 0 ? questions : null;
}

export function formatThoughtSubmission(answers: string[], supplement: string): string {
  let result = "";
  answers.forEach((ans, i) => {
    if (ans.trim()) {
      result += `问题${i + 1}答案：${ans.trim()}\n`;
    }
  });
  if (supplement.trim()) {
    result += `补充回答：${supplement.trim()}\n`;
  }
  return result.trim();
}

export function estimateTokens(text: string): number {
  let tokens = 0;
  for (const char of text) {
    if (/[一-龥]/.test(char)) {
      tokens += 2;
    } else if (/[a-zA-Z]/.test(char)) {
      tokens += 0.25;
    } else {
      tokens += 0.5;
    }
  }
  return Math.ceil(tokens);
}
