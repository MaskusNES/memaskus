# Integration tests with isolated paths and mocked host commands; no real service is touched.
import os,pathlib,tempfile,subprocess,shutil
source=(pathlib.Path(__file__).resolve().parents[1]/'deploy/install-vps.sh').read_text()
for mode in ['success','install-failure','readiness-failure']:
 with tempfile.TemporaryDirectory(prefix='memaskus-deploy-test-') as tmp:
  root=pathlib.Path(tmp)
  for name in ['opt/agent-memory/current','var/lib/agent-memory','var/backups/agent-memory','etc/systemd/system','run/lock','bin','archive/dist/cli','archive/deploy']:
   (root/name).mkdir(parents=True,exist_ok=True)
  (root/'opt/agent-memory/current/marker').write_text('old')
  (root/'var/lib/agent-memory/memory.sqlite').write_text('original-database')
  (root/'etc/systemd/system/agent-memory.service').write_text('old-unit')
  for name in ['dist/index.js','dist/cli/backup-database.js','deploy/agent-memory.service','marker']:
   (root/'archive'/name).write_text('new')
  subprocess.run(['tar','-czf',str(root/'release.tgz'),'-C',str(root/'archive'),'.'],check=True)
  mocks={
   'id':'exit 0',
   'install':'mkdir -p "$TEST_ROOT/var/lib/agent-memory" "$TEST_ROOT/var/backups/agent-memory"',
   'chown':'exit 0',
   'npm':'echo npm >> "$TEST_ROOT/events"; test "$TEST_MODE" != install-failure',
   'node':'if [ "${2:-}" = backup ]; then cp "$3" "$4"; fi',
   'systemctl':'echo "systemctl $*" >> "$TEST_ROOT/events"',
   'curl':'test "$TEST_MODE" != readiness-failure',
   'sleep':'exit 0',
  }
  for name,body in mocks.items():
   p=root/'bin'/name;p.write_text('#!/bin/bash\n'+body+'\n');p.chmod(0o755)
  script=source
  for prefix in ['/opt/agent-memory','/var/lib/agent-memory','/var/backups/agent-memory','/etc/systemd/system','/run/lock']:
   script=script.replace(prefix,str(root)+prefix)
  p=root/'install.sh';p.write_text(script)
  env={**os.environ,'PATH':str(root/'bin')+':'+os.environ['PATH'],'TEST_ROOT':str(root),'TEST_MODE':mode}
  result=subprocess.run(['bash',str(p),str(root/'release.tgz')],env=env,capture_output=True,text=True)
  events=(root/'events').read_text()
  assert (root/'var/lib/agent-memory/memory.sqlite').read_text()=='original-database'
  if mode=='success':
   assert result.returncode==0,result.stderr
   assert (root/'opt/agent-memory/current/marker').read_text()=='new'
   assert events.index('npm')<events.index('systemctl stop')
   assert list((root/'opt/agent-memory/releases').glob('*.previous/marker'))
  else:
   assert result.returncode!=0,result.stdout
   assert (root/'opt/agent-memory/current/marker').read_text()=='old'
   assert (root/'etc/systemd/system/agent-memory.service').read_text()=='old-unit'
   if mode=='install-failure':assert 'systemctl stop' not in events
   else:assert 'systemctl start agent-memory' in events
  print(mode+': OK')
