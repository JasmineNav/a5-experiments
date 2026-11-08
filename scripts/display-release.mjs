import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {readFile,mkdir,mkdtemp,rename,rm} from 'node:fs/promises';
import {join} from 'node:path';

// 发布版本与字节校验的唯一固定来源；更新 submodule 时一起更新。
export const displayRelease=Object.freeze({
  repository:'5nix/glasses-display',version:'2.2.1',
  sha256:'a47d9993827b6fff15fbf2347c7ca5d8fc71ed15e0dae74d5ac0f4106e848dff',
});
export const apkName=(release=displayRelease)=>`glasses-display-${release.version}-debug.apk`;
const execute=promisify(execFile);
export async function verifyApk(path,release=displayRelease){
  const sha=createHash('sha256').update(await readFile(path)).digest('hex');
  if(sha!==release.sha256)throw new Error(`共享显示端 APK SHA-256 不符，未安装：${path}`);
  return path;
}
/** 本地/手动打包优先；下载只写缓存，安装前始终与已固定的值核对。 */
export async function obtainDisplayApk({root,localPath,cacheDirectory=join(root,'.a5-local','artifacts'),release=displayRelease,run=execute,request=fetch,env=process.env}={}){
  const name=apkName(release);
  for(const path of [...new Set([localPath,join(root,'artifacts',name),join(cacheDirectory,name)].filter(Boolean))]){
    try{await readFile(path);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    return verifyApk(path,release);
  }
  await mkdir(cacheDirectory,{recursive:true});
  const temp=await mkdtemp(join(cacheDirectory,'.download-'));
  const downloaded=join(temp,name),destination=join(cacheDirectory,name);
  try{
    let ghReady=false;
    try{await run('gh',['auth','status'],{windowsHide:true,timeout:15000,env});ghReady=true;}catch{}
    if(ghReady){
      await run('gh',['release','download',`v${release.version}`,'--repo',release.repository,'--pattern',name,'--dir',temp],{windowsHide:true,timeout:180000,env});
    }else{
      const headers={'Accept':'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28'};
      const token=env.GH_TOKEN||env.GITHUB_TOKEN;
      if(token)headers.Authorization=`Bearer ${token}`;
      const base=`https://api.github.com/repos/${release.repository}`;
      const metadata=await request(`${base}/releases/tags/v${release.version}`,{headers,signal:AbortSignal.timeout(30000)});
      if(!metadata.ok)throw new Error(`无法下载私有显示端 Release（HTTP ${metadata.status}）：请用有仓库访问权的 gh 登录，或设置 GH_TOKEN/GITHUB_TOKEN；也可手动放入 artifacts/${name}。`);
      const asset=(await metadata.json()).assets?.find(a=>a.name===name);
      if(!asset||!Number.isSafeInteger(asset.id))throw new Error(`Release 缺少 ${name}。`);
      const response=await request(`${base}/releases/assets/${asset.id}`,{headers:{...headers,Accept:'application/octet-stream'},signal:AbortSignal.timeout(180000)});
      if(!response.ok)throw new Error(`APK 下载失败（HTTP ${response.status}）。`);
      const {writeFile}=await import('node:fs/promises');
      await writeFile(downloaded,Buffer.from(await response.arrayBuffer()));
    }
    await verifyApk(downloaded,release);
    await rename(downloaded,destination);
    return destination;
  }finally{await rm(temp,{recursive:true,force:true});}
}
