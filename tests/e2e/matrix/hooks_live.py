#!/usr/bin/env python3
"""가짜 API 키로 claude -p 를 띄워 SessionStart/UserPromptSubmit 등 hook 이 실제 기동되는지 stream-json 으로 집계 (LLM 호출 없음: 401).
usage: hooks_live.py <label> [extra claude args]"""
import subprocess,sys,json,os,collections
label=sys.argv[1]; extra=sys.argv[2:]
env=dict(os.environ,ANTHROPIC_API_KEY='sk-ant-api03-fake-audit-key-000000000000000000000000000000000000000000000000')
r=subprocess.run([os.environ.get('CLAUDE_BIN','claude'),'-p','hi','--output-format','stream-json','--verbose','--include-hook-events','--no-session-persistence']+extra,capture_output=True,text=True,timeout=90,env=env,stdin=subprocess.DEVNULL)
c=collections.Counter(); ex=[]
for l in r.stdout.splitlines():
  try:j=json.loads(l)
  except: continue
  if j.get('type')=='system' and 'hook' in str(j.get('subtype','')):
    k=(j.get('subtype'),j.get('hook_event'),j.get('outcome') or j.get('exit_code'))
    c[k]+=1
    if j.get('subtype')=='hook_response' and j.get('outcome') not in (None,'success') and len(ex)<2: ex.append((j.get('hook_name'),str(j.get('stderr') or j.get('output'))[:160]))
print(f'[{label}] rc={r.returncode} hook events:',dict(c)); 
for e in ex: print('   ',e)
if not c: print('   stdout head:',r.stdout[:200].replace('\n',' '),'| stderr:',r.stderr[:200])
