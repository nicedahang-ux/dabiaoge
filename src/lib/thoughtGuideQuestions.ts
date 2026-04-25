export interface ThoughtQuestion {
  number: number;
  text: string;
}

export function parseThoughtQuestions(content: string): ThoughtQuestion[] | null {
  if (!content.includes("【关键提问】")) return null;

  const questionBlockMatch = content.match(/【关键提问】[\s\S]*?(?=【提醒】|【行动呼吁】|【诊断反馈】|$)/);
  if (!questionBlockMatch) return null;

  const block = questionBlockMatch[0];
  const questions: ThoughtQuestion[] = [];

  const lines = block.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^(\d+)[.．、\s]+(.+)$/);
    if (match) {
      questions.push({
        number: parseInt(match[1], 10),
        text: match[2].trim(),
      });
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
