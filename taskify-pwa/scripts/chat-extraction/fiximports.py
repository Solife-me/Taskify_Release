import os, re, sys, json
# moves: old path (no ext) -> new path (no ext), relative to src/
moves=json.loads(sys.argv[1])
root='src'
def resolve(fromfile, spec):
    if not spec.startswith('.'): return None
    base=os.path.normpath(os.path.join(os.path.dirname(fromfile), spec))
    return base
def rel(fromfile, target):
    r=os.path.relpath(target, os.path.dirname(fromfile))
    if not r.startswith('.'): r='./'+r
    return r
# map new location of moved files to know where a moved file used to live
inv={v:k for k,v in moves.items()}
changed=0
for dp,_,fs in os.walk(root):
    for f in fs:
        if not re.search(r'\.(ts|tsx)$', f): continue
        path=os.path.join(dp,f)
        noext=re.sub(r'\.(test\.)?(ts|tsx)$','',path)
        # where this file used to be (for resolving its old relative imports)
        old_self = inv.get(re.sub(r'\.(ts|tsx)$','',path)) 
        if old_self is None and path.endswith(('.test.ts','.test.tsx')):
            o=inv.get(re.sub(r'\.test\.(ts|tsx)$','',path))
            old_self=o+'.test' if o else None
        s=open(path).read()
        def repl(m):
            q,spec=m.group(1),m.group(2)
            if not spec.startswith('.'): return m.group(0)
            origin = (old_self+'.ts') if old_self else path
            target=resolve(origin, spec)
            target_new=moves.get(target, target)
            newspec=rel(path, target_new)
            if newspec!=spec: return f'{q}{newspec}{q}'
            return m.group(0)
        s2=re.sub(r'(?<=from )(["\'])([^"\']+)\1', lambda m: repl(m), s)
        s2=re.sub(r'(?<=import\()(["\'])([^"\']+)\1', lambda m: repl(m), s2)
        s2=re.sub(r'(?<=vi\.mock\()(["\'])([^"\']+)\1', lambda m: repl(m), s2)
        if s2!=s:
            open(path,'w').write(s2); changed+=1
print('files changed', changed)
