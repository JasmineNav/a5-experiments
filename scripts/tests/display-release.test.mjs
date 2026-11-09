import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {join} from 'node:path';import {tmpdir} from 'node:os';import {createHash} from 'node:crypto';
import {obtainDisplayApk,apkName,displayRelease} from '../display-release.mjs';
import {execFileSync} from 'node:child_process';
import {adbCandidates,compareVersions,configuredApkPath} from '../device-tools.mjs';
import {localDeviceControl} from '../local-device-launch.mjs';
const bytes=Buffer.from('test APK bytes'),release={repository:'5nix/glasses-display',tag:'v2.2.1',version:'2.2.1',sha256:createHash('sha256').update(bytes).digest('hex')};
async function fixture(fn){const root=await mkdtemp(join(tmpdir(),'a5-apk-'));try{await fn(root);}finally{await rm(root,{recursive:true,force:true});}}
test('手动 artifacts APK 优先，无 gh/网络/Android 工具链也可运行',()=>fixture(async root=>{
 await mkdir(join(root,'artifacts'));const path=join(root,'artifacts',apkName(release));await writeFile(path,bytes);
 assert.equal(await obtainDisplayApk({root,release,run:()=>{throw new Error('不应运行');},request:()=>{throw new Error('不应下载');}}),path);
}));
test('本地 APK 校验失败就停止，不绕过固定 SHA 或自动替换',()=>fixture(async root=>{
 await mkdir(join(root,'artifacts'));await writeFile(join(root,'artifacts',apkName(release)),'wrong');
 await assert.rejects(obtainDisplayApk({root,release,request:()=>{throw new Error('不应下载');}}),/SHA-256 不符/);
}));
test('已登录 gh 下载指定版本资源，校验后缓存，之后离线复用',()=>fixture(async root=>{
 const calls=[];const run=async(_file,args)=>{calls.push(args);if(args[0]==='release'){assert.deepEqual(args.slice(0,3),['release','download','v2.2.1']);await writeFile(join(args.at(-1),apkName(release)),bytes);}};
 const path=await obtainDisplayApk({root,release,run,request:()=>{throw new Error('不应回退');}});
 assert.deepEqual(await readFile(path),bytes);assert.equal(calls.length,2);
 assert.equal(await obtainDisplayApk({root,release,run:()=>{throw new Error('不应运行');}}),path);
}));
test('gh 不可用时用 HTTPS + 环境 token 读取私有 Release 并下载资源',()=>fixture(async root=>{
 const urls=[];const request=async(url,options)=>{urls.push(url);assert.equal(options.headers.Authorization,'Bearer test-only');return urls.length===1?Response.json({assets:[{id:42,name:apkName(release)}]}):new Response(bytes);};
 const path=await obtainDisplayApk({root,release,env:{GH_TOKEN:'test-only'},run:async()=>{throw new Error('gh absent');},request});
 assert.deepEqual(await readFile(path),bytes);assert.match(urls[0],/releases\/tags\/v2.2.1$/);assert.match(urls[1],/releases\/assets\/42$/);
}));
test('gh 下载错误或下载字节不匹配不会安装，也不更换渠道绕过失败',()=>fixture(async root=>{
 await assert.rejects(obtainDisplayApk({root,release,run:async(_file,args)=>{if(args[0]==='release')throw new Error('no release access');},request:()=>{throw new Error('不应回退');}}),/no release access/);
 await assert.rejects(obtainDisplayApk({root,release,run:async(_file,args)=>{if(args[0]==='release')await writeFile(join(args.at(-1),apkName(release)),'corrupt');}}),/SHA-256 不符/);
}));
test('下载无访问权时给手动打包提示；token 不写入诊断',()=>fixture(async root=>{
 await assert.rejects(obtainDisplayApk({root,release,env:{GH_TOKEN:'not-a-real-token'},run:async()=>{throw new Error('gh absent');},request:async()=>new Response('',{status:404})}),error=>/artifacts\//.test(error.message)&&!error.message.includes('not-a-real-token'));
}));
test('固定版本与已固定 submodule 的 host 版本相同',async()=>{
 const pkg=JSON.parse(await readFile(new URL('../../vendor/glasses-display/host/package.json',import.meta.url),'utf8'));
 assert.equal(displayRelease.version,pkg.version);
});

test('固定提交与已检出的 submodule 一致；服务端读取同一份 display-release.json',async()=>{
 const root=new URL('../..',import.meta.url);
 const pinned=JSON.parse(await readFile(new URL('display-release.json',root),'utf8'));
 assert.deepEqual({...displayRelease},pinned);
 assert.match(pinned.sha256,/^[0-9a-f]{64}$/);assert.equal(pinned.tag,`v${pinned.version}`);
 let head=null;try{head=execFileSync('git',['-C',new URL('vendor/glasses-display',root).pathname,'rev-parse','HEAD'],{encoding:'utf8'}).trim();}catch{}
 if(head)assert.equal(head,pinned.commit);
 const server=await import('../../packages/a5-glasses/src/display-release.ts');assert.deepEqual({...server.displayRelease},pinned);
});
test('设备配置的 apkPath 优先生效；缺失时明确报错，不静默换来源',()=>fixture(async root=>{
 const custom=join(root,'custom.apk');await writeFile(custom,bytes);
 await mkdir(join(root,'artifacts'));await writeFile(join(root,'artifacts',apkName(release)),'wrong');
 assert.equal(await obtainDisplayApk({root,release,localPath:custom,run:()=>{throw new Error('不应运行');}}),custom);
 await assert.rejects(obtainDisplayApk({root,release,localPath:join(root,'missing.apk'),run:()=>{throw new Error('不应运行');}}),/apkPath 不存在/);
 assert.equal(configuredApkPath({apkPath:'artifacts/x.apk'},root),join(root,'artifacts/x.apk'));
 assert.equal(configuredApkPath({apkPath:custom},'/elsewhere'),custom);assert.equal(configuredApkPath({},root),undefined);
}));
test('macOS 与 Windows 都走真机启动链路，ADB 候选按平台区分',async()=>{
 const root=await mkdtemp(join(tmpdir(),'a5-plat-'));
 try{
  await mkdir(join(root,'scripts'));await writeFile(join(root,'scripts/glasses-control.mjs'),'');
  for(const platform of ['win32','darwin'])assert.equal(await localDeviceControl({name:'f5-sh-pilot'},{root,platform}),join(root,'scripts/glasses-control.mjs'));
  const mac=adbCandidates({},{local:'/r/.a5-local',platform:'darwin',env:{},home:'/Users/lab'});
  assert.ok(mac.includes('/Users/lab/Library/Android/sdk/platform-tools/adb')&&mac.includes('/opt/homebrew/bin/adb'));assert.ok(mac.every(p=>!p.endsWith('.exe')));
  const win=adbCandidates({adbPath:'C:/adb.exe'},{local:'C:/r/.a5-local',platform:'win32',env:{LOCALAPPDATA:'C:/L'},home:'C:/U'});
  assert.ok(win.includes('C:/adb.exe')&&win.every(p=>p.endsWith('.exe')));
 }finally{await rm(root,{recursive:true,force:true});}
});
test('版本比较按数字段，较新版本不降级安装',()=>{
 assert.equal(compareVersions('2.2.10','2.2.4'),1);assert.equal(compareVersions('2.2.4','2.2.4'),0);assert.equal(compareVersions('2.2.1','2.2.4'),-1);assert.equal(compareVersions('1.1.5','2.2.4'),-1);
});
