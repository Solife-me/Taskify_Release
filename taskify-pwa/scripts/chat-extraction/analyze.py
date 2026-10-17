import re, json, sys
SP='/private/tmp/claude-501/-Users-nathanhughes-Github-Taskify-Release/f9ba2619-98f6-4856-a079-a138f009c8cc/scratchpad/chat/'
src=open('src/components/CashuWalletModal.tsx').read()
lines=src.split('\n')
# component body: from line after "}: CashuWalletModalProps) {" to the line before "  return ("
start=next(i for i,l in enumerate(lines) if l.startswith('}: CashuWalletModalProps) {'))+1
ret=next(i for i,l in enumerate(lines) if i>start and l.startswith('  if (!open) return null;'))
body=lines[start:ret]
stmts=[]; cur=None; pending_comments=[]
for idx,l in enumerate(body):
    ln=start+idx+1
    is_top = re.match(r'^  [A-Za-z_]', l) is not None
    if is_top:
        if cur: stmts.append(cur)
        cur={'start':ln,'lines':pending_comments+[l]}; pending_comments=[]
    else:
        if re.match(r'^  //', l) and cur is not None and False: pass
        if cur is None: pending_comments.append(l)
        else: cur['lines'].append(l)
if cur: stmts.append(cur)
def strip(t):
    t=re.sub(r'//[^\n]*','',t)
    t=re.sub(r'/\*.*?\*/','',t,flags=re.S)
    t=re.sub(r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'','""',t)
    return t
for s in stmts:
    text='\n'.join(s['lines']); s['text']=text
    t=strip(text)
    defs=set()
    head=t.strip()
    m=re.match(r'(?:const|let)\s+\[([^\]]*)\]\s*=',head)
    if m: defs|={x.strip() for x in m.group(1).split(',') if x.strip()}
    m=re.match(r'(?:const|let)\s+\{(.*?)\}\s*=',head,flags=re.S)
    if m:
        for x in m.group(1).split(','):
            x=x.strip()
            if not x: continue
            x=x.split(':')[-1].strip().split('=')[0].strip()
            if x.startswith('...'): x=x[3:]
            defs.add(x)
    m=re.match(r'(?:const|let)\s+([A-Za-z_]\w*)',head)
    if m and not defs: defs.add(m.group(1))
    m=re.match(r'(?:async\s+)?function\s+([A-Za-z_]\w*)',head)
    if m: defs.add(m.group(1))
    m=re.match(r'type\s+([A-Za-z_]\w*)',head)
    if m: defs.add(m.group(1))
    s['defs']=sorted(defs)
    s['uses']=sorted(set(re.findall(r'(?<![.\w])([A-Za-z_]\w*)',t))-defs)
    s['kind']='effect' if re.match(r'\s*use(Layout)?Effect\(',head) else ('decl' if defs else 'other')
json.dump([{k:v for k,v in s.items() if k!='lines'} for s in stmts], open(SP+'stmts.json','w'))
print(len(stmts), 'statements; body lines', start, ret)
