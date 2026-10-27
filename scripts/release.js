// Publish an update: bumps the version, builds the Windows app and the iPhone script, commits,
// pushes and creates the GitHub release. Every installed copy then updates itself.
//
//   node scripts/release.js [patch|minor|major] ["What changed"]
//   release.bat patch "Fixed subtitles on some files"
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const run = (cmd, args, opts = {}) => execFileSync(cmd, args, { cwd: root, stdio: 'inherit', ...opts });
const out = (cmd, args) => execFileSync(cmd, args, { cwd: root, encoding: 'utf8' }).trim();

const bump = ['patch', 'minor', 'major'].includes(process.argv[2]) ? process.argv[2] : 'patch';
const notes = process.argv.slice(['patch', 'minor', 'major'].includes(process.argv[2]) ? 3 : 2).join(' ')
    || 'Improvements and fixes.';

const gh = [process.env.GH, path.join(process.env.LOCALAPPDATA || '', 'Programs', 'gh', 'bin', 'gh.exe')]
    .find(p => p && fs.existsSync(p)) || 'gh';

if (out('git', ['rev-parse', '--abbrev-ref', 'HEAD']) !== 'main') throw new Error('Switch to the main branch first.');

// 1. New version number.
const pkgPath = path.join(root, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
const v = pkg.version.split('.').map(Number);
if (bump === 'major') { v[0]++; v[1] = 0; v[2] = 0; } else if (bump === 'minor') { v[1]++; v[2] = 0; } else v[2]++;
pkg.version = v.join('.');
fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
const tag = 'v' + pkg.version;
console.log(`\nReleasing ${tag}\n`);

// 2. Build the iPhone script and the Windows app.
run(process.execPath, ['build-ios.js']);
fs.rmSync(path.join(root, 'dist'), { recursive: true, force: true });
run(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['electron-builder', '--win', 'portable'], {
    shell: true,
    env: {
        ...process.env,
        ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
        ELECTRON_BUILDER_CACHE: path.join(root, '.cache', 'electron-builder'),
        ELECTRON_CACHE: path.join(root, '.cache', 'electron')
    }
});
const dist = path.join(root, 'dist');
const assets = [
    path.join(dist, 'DipaCableNetworkFTP-Portable.exe'),
    path.join(dist, 'DipaCableNetworkFTP-iPhone.js'),
    path.join(dist, 'DipaCableNetworkFTP-iPhone-Starter.js')
];
fs.copyFileSync(path.join(root, 'ios', 'Movie Fetcher.js'), assets[1]);
fs.copyFileSync(path.join(root, 'ios', 'Starter.js'), assets[2]);
for (const a of assets) if (!fs.existsSync(a)) throw new Error('Missing build output: ' + a);

// 3. Commit, tag and push.
run('git', ['add', '-A']);
run('git', ['commit', '-m', `Release ${tag}`, '-m', notes]);
run('git', ['tag', tag]);
run('git', ['push', 'origin', 'main', tag]);

// 4. Publish. Installed apps pick this up on their next start (or within 30 minutes).
run(gh, ['release', 'create', tag, ...assets, '--title', `Dipa Cable Network FTP ${tag}`, '--notes', notes]);
console.log(`\nPublished ${tag}: https://github.com/aniktanims/dipa-cable-network-ftp/releases/tag/${tag}\n`);
