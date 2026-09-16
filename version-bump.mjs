import { readFileSync, writeFileSync } from 'fs';

const targetVersion = process.env.npm_package_version;

if (!targetVersion) {
  console.error('无法确定目标版本号：请通过 `npm version <x.y.z>` 调用本脚本。');
  process.exit(1);
}

// 更新 manifest.json
const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));

// minAppVersion 以 manifest.json 为准；仅在显式提供 npm_package_min_app_version 时才覆盖。
// 注意：不要再用 '1.0.0' 之类硬编码兜底，否则 versions.json 会写入错误的最低版本。
const minAppVersion = process.env.npm_package_min_app_version || manifest.minAppVersion;
if (!minAppVersion) {
  console.error('无法确定 minAppVersion：manifest.json 缺少 minAppVersion 字段。已中止，避免写入错误值。');
  process.exit(1);
}

const prevVersion = manifest.version;
manifest.version = targetVersion;
writeFileSync('manifest.json', JSON.stringify(manifest, null, 2) + '\n');

// 更新 versions.json
const versions = JSON.parse(readFileSync('versions.json', 'utf8'));
if (versions[targetVersion] && versions[targetVersion] !== minAppVersion) {
  console.warn(`versions.json 中已存在 ${targetVersion}（${versions[targetVersion]}），将覆盖为 ${minAppVersion}`);
}
versions[targetVersion] = minAppVersion;
writeFileSync('versions.json', JSON.stringify(versions, null, 2) + '\n');

console.log(
  `Updated manifest.json (${prevVersion} -> ${targetVersion}) and versions.json (${targetVersion}: ${minAppVersion})`
);
