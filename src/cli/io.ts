import readline from 'readline';
import { SetupIO } from '../core/types';
import { c } from './render';

export const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;

function prompt(question: string, secret = false): Promise<string> {
  if (!interactive()) return Promise.reject(new Error('This step needs an interactive terminal'));
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    let muted = false;
    if (secret) {
      const write = (rl as any)._writeToOutput.bind(rl);
      (rl as any)._writeToOutput = (s: string) => {
        if (!muted) write(s);
        else if (s.includes('\n') || s.includes('\r')) write('\n');
        else write('*'.repeat(s.length));
      };
    }
    rl.on('SIGINT', () => {
      rl.close();
      process.stdout.write('\n');
      reject(new Error('Cancelled'));
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
    muted = secret;
  });
}

/** Terminal implementation of the interactive setup channel. */
export const cliIO: SetupIO = {
  info: (m) => console.log(m),
  warn: (m) => console.log(c.yellow('⚠ ') + m),
  success: (m) => console.log(c.green('✓ ') + m),

  steps(title, steps) {
    console.log('\n' + c.bold(title));
    steps.forEach((s, i) => console.log(`  ${c.cyan(String(i + 1) + '.')} ${s}`));
    console.log();
  },

  async ask(question, opts = {}) {
    for (;;) {
      const suffix = opts.default ? c.dim(` (${opts.default})`) : '';
      const answer = (await prompt(`${c.cyan('?')} ${question}${suffix}: `, opts.secret)) || opts.default || '';
      const error = !answer ? 'A value is required' : opts.validate?.(answer);
      if (!error) return answer;
      console.log(c.red(`  ${error}`));
    }
  },

  async confirm(question, def = true) {
    const answer = (await prompt(`${c.cyan('?')} ${question} ${c.dim(def ? '[Y/n]' : '[y/N]')} `)).toLowerCase();
    return answer ? answer.startsWith('y') : def;
  },

  async choose(question, options) {
    console.log(`${c.cyan('?')} ${question}`);
    options.forEach((o, i) => console.log(`  ${c.cyan(String(i + 1).padStart(2))}) ${o.label}${o.hint ? c.dim(`  — ${o.hint}`) : ''}`));
    for (;;) {
      const n = Number(await prompt(`  ${c.dim('Choose 1-' + options.length)}: `));
      if (Number.isInteger(n) && n >= 1 && n <= options.length) return options[n - 1].value;
    }
  },

  async wait(message, task) {
    return spinner(message, task);
  },
};

export async function spinner<T>(message: string, task: (update: (msg: string) => void) => Promise<T>): Promise<T> {
  if (!process.stderr.isTTY) {
    console.error(message);
    return task(() => {});
  }
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let i = 0;
  let text = message;
  const draw = () => process.stderr.write(`\r\x1b[2K${c.cyan(frames[i++ % frames.length])} ${text}`);
  const timer = setInterval(draw, 80);
  draw();
  try {
    return await task((m) => (text = m));
  } finally {
    clearInterval(timer);
    process.stderr.write('\r\x1b[2K');
  }
}
