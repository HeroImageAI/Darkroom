const fs = require('fs');
const rep = (s, a, b) => { if (!s.includes(a)) throw new Error('missing: ' + a.slice(0, 60)); return s.replace(a, b); };
let g = fs.readFileSync('src/web/screens/Generate.tsx', 'utf8');
g = rep(g, `  onScreen,
  note,
}: {`, `  onScreen,
  hint,
  token,
  onInsert,
}: {`);
g = rep(g, `  onScreen: () => void;
  note?: string;
}) {`, `  onScreen: () => void;
  hint?: string;
  token: (n: number) => string;
  onInsert: (token: string) => void;
}) {`);
g = rep(g, `              <button className="x" aria-label={\`Remove reference \${i + 1}\`} onClick={() => onRemove(i)}>
                <X size={14} />
              </button>
            </div>`, `              <button className="x" aria-label={\`Remove reference \${i + 1}\`} onClick={() => onRemove(i)}>
                <X size={14} />
              </button>
              <button
                type="button"
                className="mono"
                title="Insert this reference's name into the prompt"
                onClick={() => onInsert(token(i + 1))}
                style={{ position: 'absolute', left: 4, bottom: 4, fontSize: 11, border: 0, borderRadius: 4, padding: '2px 6px', background: 'rgba(18,18,16,.85)', color: 'var(--accent)' }}
              >
                {token(i + 1)}
              </button>
            </div>`);
g = rep(g, `      {note && <p className="note warn" style={{ marginTop: 6 }}>{note}</p>}`, `      {refs.length > 0 && hint && <p className="note" style={{ marginTop: 6 }}>{hint}</p>}`);
fs.writeFileSync('src/web/screens/Generate.tsx', g);
console.log('refslots ok');
