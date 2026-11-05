#!/usr/bin/env python3
"""settings.json 의 모든 hook/statusLine 명령 + ~/.claude.json MCP 를 지정 PATH 로 실제 실행해 rc/stderr 요약.
usage: probe.py <label> [PATH]   (PATH 생략 시 현재 환경)"""
import json,os,subprocess,sys,collections
label=sys.argv[1]; env=dict(os.environ)
if len(sys.argv)>2: env['PATH']=sys.argv[2]
s=json.load(open(os.path.expanduser('~/.claude/settings.json')))
res=collections.Counter(); errs=collections.Counter()
cmds=[]
for ev,groups in s.get('hooks',{}).items():
  for g in groups:
    for h in g.get('hooks',[]):
      if h.get('command'): cmds.append((ev,h['command']))
sl=s.get('statusLine',{}).get('command')
if sl: cmds.append(('statusLine',sl))
for ev,c in cmds:
  inp=json.dumps({"session_id":"probe","cwd":os.getcwd(),"hook_event_name":ev,"prompt":"hello","tool_name":"Bash","tool_input":{"command":"ls"},"transcript_path":"/nonexistent"})
  try:
    r=subprocess.run(['sh','-c',c],input=inp,capture_output=True,text=True,timeout=20,env=env)
    rc=r.returncode; e=(r.stderr.strip().splitlines() or [''])[0][:110]
  except subprocess.TimeoutExpired: rc='timeout'; e=''
  res[rc]+=1
  if rc not in (0,): errs[(rc,e)]+=1
print(f"[{label}] n={len(cmds)} rc={dict(res)}")
for (rc,e),n in errs.most_common(3): print(f"   x{n} rc={rc} {e}")
# MCP
try:
  m=json.load(open(os.path.expanduser('~/.claude.json')))['mcpServers']['forgen-compound']
  p=subprocess.Popen([m['command']]+m['args'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,env=env,text=True)
  req=json.dumps({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"p","version":"1"}}})+"\n"
  try: out,err=p.communicate(req,timeout=8)
  except subprocess.TimeoutExpired: p.kill(); out,err=p.communicate()
  print(f"   MCP cmd={m['command']} -> {'OK initialize' if 'result' in out else 'FAIL rc=%s %s'%(p.returncode,(err.strip().splitlines() or [''])[0][:110])}")
except Exception as ex: print('   MCP probe err',ex)
