import {readFileSync} from 'node:fs';
/** 与启动器共用仓库根目录 display-release.json：期望的显示端版本、基座提交与 APK SHA-256 只在那里固定。 */
export interface DisplayRelease { repository:string; tag:string; version:string; commit:string; sha256:string }
export const displayReleasePath=new URL('../../../display-release.json',import.meta.url);
export const displayRelease:Readonly<DisplayRelease>=Object.freeze(JSON.parse(readFileSync(displayReleasePath,'utf8')) as DisplayRelease);
