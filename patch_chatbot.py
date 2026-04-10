import re

path = r'e:\Projects\TempleMahendra\frontend\src\components\Chatbot\Chatbot.css'
with open(path, encoding='utf-8') as f:
    css = f.read()

# Light theme overrides to append
overrides = """
/* ===== LIGHT THEME OVERRIDES ===== */
.chatbot__pulse { border: 2px solid var(--saffron) !important; }
.chatbot__window {
  background: rgba(255,251,245,0.96) !important;
  border: 1px solid rgba(153,27,27,0.12) !important;
  box-shadow: var(--shadow-lg) !important;
}
.chatbot__body {
  background: rgba(255,248,240,0.40) !important;
  scrollbar-color: rgba(153,27,27,0.15) transparent !important;
}
.chatbot__body::-webkit-scrollbar-thumb { background: rgba(153,27,27,0.18) !important; }
.chatbot__bubble--assistant .chatbot__text {
  background: rgba(255,255,255,0.92) !important;
  color: var(--text-2) !important;
  border: 1px solid rgba(153,27,27,0.10) !important;
  box-shadow: 0 2px 8px rgba(153,27,27,0.06) !important;
  backdrop-filter: none !important;
}
.chatbot__typing {
  background: rgba(255,255,255,0.92) !important;
  border: 1px solid rgba(153,27,27,0.10) !important;
  box-shadow: 0 2px 8px rgba(153,27,27,0.06) !important;
}
.chatbot__typing span { background: var(--saffron) !important; }
.chatbot__chip {
  background: rgba(255,255,255,0.85) !important;
  border: 1.5px solid rgba(153,27,27,0.22) !important;
  color: var(--maroon) !important;
}
.chatbot__chip:hover {
  background: rgba(153,27,27,0.08) !important;
  border-color: var(--maroon) !important;
}
.chatbot__footer {
  border-top: 1px solid rgba(153,27,27,0.10) !important;
  background: rgba(255,248,240,0.90) !important;
}
.chatbot__input {
  border: 1.5px solid rgba(153,27,27,0.15) !important;
  background: rgba(255,255,255,0.95) !important;
  color: var(--text-1) !important;
}
.chatbot__input:focus {
  border-color: var(--saffron) !important;
  box-shadow: 0 0 0 3px rgba(249,115,22,0.10) !important;
}
.chatbot__input::placeholder { color: rgba(100,40,40,0.38) !important; }
.chatbot__send {
  background: linear-gradient(135deg, var(--maroon) 0%, var(--saffron-dark) 100%) !important;
}
.chatbot__send:hover:not(:disabled) {
  box-shadow: 0 4px 16px rgba(153,27,27,0.40) !important;
}
"""

# Append overrides
if '/* ===== LIGHT THEME OVERRIDES =====' not in css:
    css = css + overrides

with open(path, 'w', encoding='utf-8') as f:
    f.write(css)

print('Chatbot.css patched, size:', len(css))
