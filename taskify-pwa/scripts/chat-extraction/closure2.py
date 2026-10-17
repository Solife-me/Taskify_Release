import re, json
SP='/private/tmp/claude-501/-Users-nathanhughes-Github-Taskify-Release/f9ba2619-98f6-4856-a079-a138f009c8cc/scratchpad/'
stmts=json.load(open(SP+'chat/stmts.json'))
block=open(SP+'chat/chat_block_clean.txt').read() if __import__('os').path.exists(SP+'chat/chat_block_clean.txt') else open(SP+'chat_block.txt').read()
def strip(t):
    t=re.sub(r'//[^\n]*','',t); t=re.sub(r'/\*.*?\*/','',t,flags=re.S)
    t=re.sub(r'"(?:\\.|[^"\\\n])*"|\'(?:\\.|[^\'\\\n])*\'','""',t); return t
need=set(re.findall(r'(?<![.\w])([A-Za-z_]\w*)',strip(block)))
WALLET_HOOKS=json.load(open(SP+'chat/wallet_hooks.json'))
EXCLUDE=set(json.load(open(SP+'chat/exclude.json'))) if __import__('os').path.exists(SP+'chat/exclude.json') else set()
defmap={}
for i,s in enumerate(stmts):
    s['wallet']=any(h in s['text'] for h in WALLET_HOOKS) or s['start'] in EXCLUDE
    for d in s['defs']: defmap.setdefault(d,[]).append(i)
inc=set(); seen=set(); work=[n for n in need if n in defmap]
while work:
    n=work.pop()
    if n in seen: continue
    seen.add(n)
    for i in defmap.get(n,[]):
        if stmts[i]['wallet'] or i in inc: continue
        inc.add(i)
        work+= [u for u in stmts[i]['uses'] if u in defmap and u not in seen]
walletDefs=set(d for s in stmts if s['wallet'] for d in s['defs'])
chatDefs=set(d for i in inc for d in stmts[i]['defs'])
# effects: include when they touch chat defs and no wallet-only names
effects=[]
for i,s in enumerate(stmts):
    if s['kind']!='effect' and s['defs']: continue
    if i in inc: continue
    uses=set(s['uses'])
    w=(uses & walletDefs) - chatDefs
    c=uses & chatDefs
    if c and not w: effects.append(i)
    elif c and w: print('MIXED effect', s['start'], sorted(w)[:8], '| chat:', sorted(c)[:6])
inc|=set(effects)
print('chat statements', len(inc))
for i in sorted(inc):
    s=stmts[i]
    w=[u for u in s['uses'] if u in walletDefs and u not in chatDefs]
    if w: print('  uses wallet:', s['start'], s['defs'][:3], w)
missing=sorted(n for n in need if n in walletDefs and n not in chatDefs)
print('chat JSX still needs wallet names:', missing)
json.dump(sorted(inc), open(SP+'chat/closure2.json','w'))
