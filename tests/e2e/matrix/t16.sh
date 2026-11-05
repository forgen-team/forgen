. /m/lib.sh
nvm use 22 >/dev/null; npm i -g /m/new.tgz >/dev/null 2>&1
ln -s ~/.forgen ~/.compound   # 호스트와 동일: ~/.compound -> ~/.forgen
mkdir -p ~/.forgen/solutions ~/.forgen/skills
printf -- "---\nname: hometest\nversion: 1\nstatus: verified\nconfidence: 0.9\ntype: pattern\nscope: me\ntags: [zebrafoo, quokka]\nidentifiers: []\nevidence: {injected: 0, reflected: 0, negative: 0, sessions: 0, reExtracted: 0}\ncreated: 2026-01-01\nupdated: 2026-01-01\nsupersedes: null\nextractedBy: auto\n---\n\n## Context\nzebrafoo quokka\n## Content\nx\n" > ~/.forgen/solutions/hometest.md
cat > /tmp/m.mjs <<'J'
const m = await import(process.env.HOME+'/.nvm/versions/node/v22.23.4/lib/node_modules/@wooojin/forgen/dist/engine/solution-matcher.js');
for (const cwd of [process.env.HOME, process.env.HOME+'/proj']) {
  const r = m.matchSolutions('zebrafoo quokka', {team:null}, cwd, []);
  console.log('cwd=',cwd.replace(process.env.HOME,'~'), JSON.stringify(r.map(x=>({n:x.name??x.solution?.name, s:x.scope??x.solution?.scope}))));
}
J
mkdir -p ~/proj; cd ~; node /tmp/m.mjs 2>&1 | head
