# UU主机加速插件（UFI-TOOLS）

这是一个面向 **UFI-TOOLS** 的 `UU主机加速` 插件脚本，用于在中兴随身 WiFi / Android 路由环境中安装并管理 UU 主机加速核心（`uuplugin`）。

## 功能

- 一键安装 / 启动 / 停止 / 重启 / 卸载
- 开机自启开关
- 环境检测（tun/iptables/ip_forward 等）
- 日志查看（安装日志 + 运行日志）
- 核心信息面板（核心版本探测、MD5、PID、配置摘要）

## 文件说明

- `UU主机加速插件.js`：推荐使用的插件脚本
- `UU加速器插件(by+jaisquidward).js`：历史命名版本（内容同步）

## 使用方式

1. 在 UFI-TOOLS 插件管理中导入 `UU主机加速插件.js`
2. 打开插件面板，点击“安装”完成核心部署
3. 点击“启动”，确认状态为运行中
4. 通过“核心信息”查看核心版本和运行摘要
5. 在手机端使用 **UU主机加速器 App** 完成设备绑定与加速

## 相关链接

- UFI-TOOLS 项目主页：
  - https://github.com/kanoqwq/UFI-TOOLS
- 网易UU加速器官网：
  - https://www.uu-163.com/
- UU主机加速路由插件核心接口（官方）：
  - https://router.uu.163.com/api/plugin?type=openwrt-arm

## 免责声明

本插件仅用于学习与设备管理自动化，`uuplugin` 二进制及加速服务版权归网易UU官方所有。请遵守官方服务协议与当地法律法规。
