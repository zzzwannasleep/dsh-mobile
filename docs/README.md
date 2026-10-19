# 使用指南 / Documentation

第一次使用请先看[快速开始](../README.md#快速开始)和[局域网／远程连接教程](../README.md#连接教程)。这里收录需要进一步配置或排障的专题；不必为了完成首次配对读完所有页面。

## 已发布功能 / Released features

| 你想做什么 | 中文 | English |
| --- | --- | --- |
| 使用 Android App、了解返回键、权限与升级 | [App 手册](../apps/mobile/README.zh-CN.md) | [Android app](../apps/mobile/README.md) |
| 在 Windows 电脑的浏览器里使用 DSH（待发布） | [PC 端](PC_CLIENT.md) | [PC client](PC_CLIENT.en.md) |
| 使用固定 Cloudflare 域名，而非临时随机地址 | [命名隧道](CLOUDFLARE_TUNNEL.md) | [Named tunnel](CLOUDFLARE_TUNNEL.en.md) |
| 页面加载慢、实时连接反复重连或长操作超时 | [慢链路与重连](SLOW_CONNECTIONS.md) | [Slow links and reconnection](SLOW_CONNECTIONS.en.md) |

在 Android App 中连接远程通道时请选择 **远程访问**。远程通道仍要求 DSH Mobile 配对，不能直接暴露普通 DSH。SakuraFrp 仅支持 TCP 类型隧道：默认模式由插件在本机用私有 CA 终结 TLS，App 配对时固定该 CA；把隧道绑定到子域名并开启自动 HTTPS 后，公网 TLS 改由 frpc 用 natfrp 的公开证书终结，App 按平台信任校验、不固定插件 CA，电脑端安装包也不含证书。

## 0.6.0 新增功能 / New features

以下指南介绍 0.6.0 的模块管理与局域网高级设置。

| 功能 | 中文 | English | 使用状态 |
| --- | --- | --- | --- |
| 为移动页面选择加载模块 | [模块设置](CLIENT_MODULES.md) | [Module settings](CLIENT_MODULES.en.md) | 电脑默认与设备覆盖分别保存，不自动刷新会话 |
| 允许受控路由网络访问 LAN Gateway | [额外可信网段](TRUSTED_NETWORKS.md) | [Trusted networks](TRUSTED_NETWORKS.en.md) | 不建立 VPN，不自动扩大防火墙规则 |

## 开发与安全 / Development and security

0.6.3 的 [扩展 Worker 指南](EXTENSION_WORKERS.md)／[Worker guide](EXTENSION_WORKERS.en.md) 介绍按扩展启用、预算与显式恢复；此功能不迁移普通 Cordis 插件，也不是权限沙箱。

- [贡献指南](../CONTRIBUTING.md)：本地检查、浏览器与 Android 验证、发布要求。
- [安全说明](../SECURITY.md)：配对授权、TLS、组件清理与私密漏洞反馈。
- [贡献记录](../CONTRIBUTORS.md)与[更新记录](../CHANGELOG.md)：分别查看社区参与和版本变化。

## 历史验证 / Historical records

以下记录保留原来的版本和测试范围，不能当作当前版本或你的网络环境已验证的证明。

| 记录 | 范围 |
| --- | --- |
| [DSH 0.1.5 局域网验证](DSH_0.1.5_LAN.md) | 0.3.15 的历史实测；当前组合见[兼容性](../README.md#兼容性) |
