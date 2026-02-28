//<script>
(() => {
    const runCMD = async (cmd, timeout = 15000) => await runShellWithRoot(cmd, timeout);
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

    const SCRIPT_VERSION = "2026-02-28.5";
    const PLUGIN_DIR = "/data/uuplugin";
    const PLUGIN_EXEC = `${PLUGIN_DIR}/uuplugin`;
    const PLUGIN_CONF = `${PLUGIN_DIR}/uu.conf`;
    const PLUGIN_TAR = `${PLUGIN_DIR}/uu.tar.gz`;

    const BOOT_SCRIPT = `${PLUGIN_DIR}/boot_start.sh`;
    const BOOT_SH = "/sdcard/ufi_tools_boot.sh";

    const PID_FILE = "/var/run/uuplugin.pid";
    const PID_PATH_ORIG = "/var/run/uuplugin.pid";
    const PID_PATH_PATCHED = "/data/uu/uuplugin.pid";
    const PID_PATH_PATCHED_OLD = "/tmp/uu/uuplugin.pidx";
    const WORK_DIR = "/data/uu";

    const LOG_FILE = "/sdcard/uuplugin.log";
    const INSTALL_LOG_FILE = "/sdcard/uuplugin_install.log";

    const STATIC_FALLBACK_VERSION = "v12.1.4";
    const STATIC_BASE = "http://uurouter.gdl.netease.com/uuplugin";
    const UU_PLUGIN_APIS = [
        "http://router.uu.163.com/api/plugin?type=",
        "https://router.uu.163.com/api/plugin?type=",
    ];
    const STATIC_URLS = {
        "openwrt-arm": `${STATIC_BASE}/openwrt-arm/${STATIC_FALLBACK_VERSION}/uu.tar.gz`,
        "openwrt-aarch64": `${STATIC_BASE}/openwrt-aarch64/${STATIC_FALLBACK_VERSION}/uu.tar.gz`,
        "openwrt-mipsel": `${STATIC_BASE}/openwrt-mipsel/${STATIC_FALLBACK_VERSION}/uu.tar.gz`,
        "openwrt-x86_64": `${STATIC_BASE}/openwrt-x86_64/${STATIC_FALLBACK_VERSION}/uu.tar.gz`,
    };

    const CURL_BIN = "/data/data/com.minikano.f50_sms/files/curl";
    let HTTP_CLIENT = null;

    const oneLine = (s = "") => String(s || "").trim().replace(/\s+/g, " ");
    const firstLine = (s = "") => String(s || "").split("\n").map((x) => x.trim()).find((x) => x) || "";
    const quoteShellSingle = (text = "") => `'${String(text).replaceAll("'", `'\\''`)}'`;

    const appendInstallLog = async (msg) => {
        const line = `[${new Date().toISOString()}] ${msg}`;
        await runCMD(`touch ${INSTALL_LOG_FILE}; echo ${quoteShellSingle(line)} >> ${INSTALL_LOG_FILE}`);
    };

    const detectArchType = async () => {
        const res = await runCMD("uname -m");
        const arch = (res.content || "").trim().toLowerCase();
        if (arch.includes("aarch64") || arch.includes("arm64")) return { arch, type: "openwrt-aarch64" };
        if (arch.includes("arm")) return { arch, type: "openwrt-arm" };
        if (arch.includes("mipsel") || arch.includes("mips")) return { arch, type: "openwrt-mipsel" };
        if (arch.includes("x86_64") || arch.includes("amd64")) return { arch, type: "openwrt-x86_64" };
        return { arch, type: null };
    };

    const isInstalled = async () => {
        const res = await runCMD(`[ -f ${PLUGIN_EXEC} ] && [ -f ${PLUGIN_CONF} ] && echo 1 || echo 0`);
        return (res.content || "").trim() === "1";
    };

    const isRunning = async () => {
        const r1 = await runCMD("pidof uuplugin");
        if ((r1.content || "").trim()) return true;
        const r2 = await runCMD(`ps -ef | grep uuplugin | grep -v grep`);
        return !!(r2.success && (r2.content || "").trim());
    };

    const isBootUp = async () => {
        await runCMD(`touch ${BOOT_SH}`);
        const res = await runCMD(`grep -qF '${BOOT_SCRIPT}' ${BOOT_SH}; echo $?`);
        return (res.content || "").trim() === "0";
    };

    const checkRoot = async () => {
        const res = await runCMD("whoami");
        return !!(res.success && (res.content || "").includes("root"));
    };

    const resolveHttpClient = async () => {
        if (HTTP_CLIENT) return HTTP_CLIENT;
        const res = await runCMD(`
if [ -x ${CURL_BIN} ]; then
  echo "${CURL_BIN}"
elif command -v curl >/dev/null 2>&1; then
  echo "curl"
elif command -v wget >/dev/null 2>&1; then
  echo "wget"
else
  echo "none"
fi
        `);
        HTTP_CLIENT = (res.content || "").trim();
        return HTTP_CLIENT;
    };

    const fetchTextByUrl = async (url, timeout = 35000) => {
        const client = await resolveHttpClient();
        if (!client || client === "none") return { success: false, content: "missing curl/wget" };
        if (client.endsWith("wget") || client === "wget") {
            return await runCMD(`(${client} -4 -q --tries=2 --timeout=12 --no-check-certificate -O - "${url}" || ${client} -q --tries=2 --timeout=12 --no-check-certificate -O - "${url}")`, timeout);
        }
        return await runCMD(`(${client} -4 -L -k -s --retry 1 --connect-timeout 8 --max-time 22 -H "Accept:text/plain" "${url}" || ${client} -L -k -s --retry 1 --connect-timeout 8 --max-time 22 -H "Accept:text/plain" "${url}")`, timeout);
    };

    const downloadFileByUrl = async (url, output, timeout = 180000) => {
        const client = await resolveHttpClient();
        if (!client || client === "none") return { success: false, content: "missing curl/wget" };
        if (client.endsWith("wget") || client === "wget") {
            return await runCMD(`(${client} -4 --tries=2 --timeout=20 --no-check-certificate -O "${output}" "${url}" || ${client} --tries=2 --timeout=20 --no-check-certificate -O "${output}" "${url}")`, timeout);
        }
        return await runCMD(`(${client} -4 -L -k --fail --retry 1 --connect-timeout 10 --max-time 120 "${url}" -o "${output}" || ${client} -L -k --fail --retry 1 --connect-timeout 10 --max-time 120 "${url}" -o "${output}")`, timeout);
    };

    const patchPidPathInBinary = async () => {
        return await runCMD(`
if [ ! -f ${PLUGIN_EXEC} ]; then echo "binary_not_found"; exit 0; fi
if grep -a "${PID_PATH_PATCHED}" ${PLUGIN_EXEC} >/dev/null 2>&1 && ! grep -a "${PID_PATH_ORIG}" ${PLUGIN_EXEC} >/dev/null 2>&1 && ! grep -a "${PID_PATH_PATCHED_OLD}" ${PLUGIN_EXEC} >/dev/null 2>&1; then
  echo "already_patched_full"
  exit 0
fi
offs_orig=$(grep -aob "${PID_PATH_ORIG}" ${PLUGIN_EXEC} 2>/dev/null | cut -d: -f1)
[ -n "$offs_orig" ] || offs_orig=$(grep -abo "${PID_PATH_ORIG}" ${PLUGIN_EXEC} 2>/dev/null | cut -d: -f1)
offs_old=$(grep -aob "${PID_PATH_PATCHED_OLD}" ${PLUGIN_EXEC} 2>/dev/null | cut -d: -f1)
[ -n "$offs_old" ] || offs_old=$(grep -abo "${PID_PATH_PATCHED_OLD}" ${PLUGIN_EXEC} 2>/dev/null | cut -d: -f1)
offs="$offs_orig
$offs_old"
if [ -z "$(printf '%s' "$offs" | tr -d ' \n\r\t')" ]; then
  echo "pattern_not_found"
  exit 0
fi
patched_count=0
for off in $offs; do
  printf '%s' "${PID_PATH_PATCHED}" | dd of=${PLUGIN_EXEC} bs=1 seek=$off conv=notrunc >/dev/null 2>&1
  patched_count=$((patched_count + 1))
done
chmod 755 ${PLUGIN_EXEC} >/dev/null 2>&1 || true
echo "patched:\${patched_count}"
        `, 18000);
    };

    const prepareRuntime = async () => {
        await runCMD(`
mkdir -p ${WORK_DIR} >/dev/null 2>&1 || true
chmod 777 ${WORK_DIR} >/dev/null 2>&1 || true
mkdir -p /tmp/uu >/dev/null 2>&1 || true
touch /tmp/uu/.uu_wtest >/dev/null 2>&1 || true
if [ ! -f /tmp/uu/.uu_wtest ]; then
  grep -q " /tmp/uu " /proc/mounts || mount -o bind ${WORK_DIR} /tmp/uu >/dev/null 2>&1 || true
  touch /tmp/uu/.uu_wtest >/dev/null 2>&1 || true
fi
rm -f /tmp/uu/.uu_wtest ${PID_PATH_PATCHED} ${PID_PATH_PATCHED_OLD} ${PID_FILE} >/dev/null 2>&1 || true
        `, 12000);
    };

    const createBootScript = async () => {
        const res = await runCMD(`
cat > ${BOOT_SCRIPT} <<'EOF'
#!/system/bin/sh
mkdir -p ${WORK_DIR} /tmp/uu >/dev/null 2>&1 || true
chmod 777 ${WORK_DIR} /tmp/uu >/dev/null 2>&1 || true
grep -q " /tmp/uu " /proc/mounts || mount -o bind ${WORK_DIR} /tmp/uu >/dev/null 2>&1 || true
rm -f ${PID_FILE} ${PID_PATH_PATCHED} ${PID_PATH_PATCHED_OLD} >/dev/null 2>&1 || true
if [ -x ${PLUGIN_EXEC} ] && [ -f ${PLUGIN_CONF} ]; then
  pkill -f '${PLUGIN_EXEC}' >/dev/null 2>&1 || true
  cd ${WORK_DIR} >/dev/null 2>&1 || cd / >/dev/null 2>&1
  export PATH=${PLUGIN_DIR}:$PATH
  nohup ${PLUGIN_EXEC} ${PLUGIN_CONF} > ${LOG_FILE} 2>&1 &
fi
EOF
chmod 755 ${BOOT_SCRIPT}
        `, 20000);
        return res.success;
    };

    const startCore = async () => {
        await runCMD(`touch ${LOG_FILE} && chmod 666 ${LOG_FILE}`);
        await runCMD(`pkill -f '${PLUGIN_EXEC}' >/dev/null 2>&1 || true`);
        await prepareRuntime();
        await patchPidPathInBinary();
        const startRes = await runCMD(`
cd ${WORK_DIR} >/dev/null 2>&1 || cd / >/dev/null 2>&1
export PATH=${PLUGIN_DIR}:$PATH
nohup ${PLUGIN_EXEC} ${PLUGIN_CONF} > ${LOG_FILE} 2>&1 &
        `, 20000);
        return startRes.success;
    };

    const stopCore = async () => {
        await runCMD(`pkill -f '${PLUGIN_EXEC}' >/dev/null 2>&1 || pkill -f '/uu/uuplugin' >/dev/null 2>&1 || killall uuplugin >/dev/null 2>&1 || true`);
        await runCMD(`rm -f ${PID_FILE} ${PID_PATH_PATCHED} ${PID_PATH_PATCHED_OLD} >/dev/null 2>&1 || true`);
        return true;
    };

    const refreshState = async () => {
        const [installed, running, boot] = await Promise.all([
            isInstalled(),
            isInstalled().then((ok) => ok ? isRunning() : false),
            isInstalled().then((ok) => ok ? isBootUp() : false),
        ]);
        const statusEl = document.querySelector("#running_uu");
        if (statusEl) {
            if (!installed) statusEl.innerHTML = "UU主机加速 - ⚪未安装";
            else statusEl.innerHTML = running ? "UU主机加速 - 🟢运行中" : "UU主机加速 - 🔴已停止";
        }
        const show = (id, display) => {
            const el = document.getElementById(id);
            if (el) el.style.display = display;
        };
        show("btn_uu_install", installed ? "none" : "inline-block");
        show("btn_uu_start", installed ? "inline-block" : "none");
        show("btn_uu_stop", installed ? "inline-block" : "none");
        show("btn_uu_restart", installed ? "inline-block" : "none");
        show("btn_uu_uninstall", installed ? "inline-block" : "none");
        show("btn_uu_boot", installed ? "inline-block" : "none");
        show("btn_uu_core", "inline-block");
        show("btn_uu_log", "inline-block");
        show("btn_uu_check", "inline-block");
        const bootBtn = document.getElementById("btn_uu_boot");
        if (bootBtn) bootBtn.style.background = boot ? "var(--dark-btn-color-active)" : "";
    };

    const actions = {
        install: async (btn) => {
            if (btn) btn.disabled = true;
            try {
                await runCMD(`echo "" > ${INSTALL_LOG_FILE}; chmod 666 ${INSTALL_LOG_FILE}`);
                await appendInstallLog(`install_begin version=${SCRIPT_VERSION}`);

                const detected = await detectArchType();
                let type = detected.type || "openwrt-arm";
                await appendInstallLog(`检测架构: ${detected.arch || "unknown"}, type: ${type}`);

                let info = null;
                const errors = [];
                for (const api of UU_PLUGIN_APIS) {
                    const url = `${api}${type}`;
                    const textRes = await fetchTextByUrl(url, 35000);
                    if (!textRes.success || !(textRes.content || "").trim()) {
                        errors.push(`${url} => ${textRes.content || "empty"}`);
                        continue;
                    }
                    const parts = String(textRes.content).trim().split(",").map((x) => x.trim());
                    if (!parts[0]) {
                        errors.push(`${url} => invalid response`);
                        continue;
                    }
                    info = { apiUrl: url, downloadUrl: parts[0], md5: parts[1] || "", backupUrl: parts[2] || "", raw: String(textRes.content).trim(), source: "api" };
                    break;
                }
                if (!info) {
                    info = { apiUrl: "static-fallback", downloadUrl: STATIC_URLS[type], md5: "", backupUrl: "", raw: `fallback=${STATIC_URLS[type]}`, source: "static" };
                    await appendInstallLog(`接口失败告警: ${errors.join(" | ")}`);
                }

                await appendInstallLog(`命中接口: ${info.apiUrl}`);
                await appendInstallLog(`下载信息: ${info.raw}`);
                await appendInstallLog(`开始下载主链接: ${info.downloadUrl}`);

                await runCMD(`mkdir -p ${PLUGIN_DIR}; rm -f ${PLUGIN_TAR}`);
                let dl = await downloadFileByUrl(info.downloadUrl, PLUGIN_TAR, 180000);
                if (!dl.success && info.backupUrl) {
                    dl = await downloadFileByUrl(info.backupUrl, PLUGIN_TAR, 180000);
                }
                if (!dl.success) {
                    await appendInstallLog(`失败: 下载失败 => ${dl.content || "unknown"}`);
                    createToast("下载失败，请查看日志", "red");
                    return;
                }
                await appendInstallLog("下载成功");

                const unzipRes = await runCMD(`
tar -zxf ${PLUGIN_TAR} -C ${PLUGIN_DIR}
chmod 755 ${PLUGIN_EXEC}
[ -f ${PLUGIN_DIR}/xtables-nft-multi ] && chmod 755 ${PLUGIN_DIR}/xtables-nft-multi || true
                `, 60000);
                if (!unzipRes.success) {
                    await appendInstallLog(`失败: 解压失败 => ${unzipRes.content || "unknown"}`);
                    createToast("解压失败", "red");
                    return;
                }
                await appendInstallLog("解压部署完成");

                const patchRes = await patchPidPathInBinary();
                await appendInstallLog(`pid_path_patch: ${patchRes.content || "empty"}`);

                const bootOk = await createBootScript();
                await appendInstallLog(`启动脚本创建: ${bootOk ? "success" : "failed"}`);
                await actions.start(false);
                await appendInstallLog("安装流程结束: success");
                createToast("安装完成", "green");
            } catch (e) {
                await appendInstallLog(`异常: ${e && e.message ? e.message : String(e)}`);
                createToast(`安装异常: ${e && e.message ? e.message : e}`, "red");
            } finally {
                if (btn) btn.disabled = false;
                refreshState();
            }
        },

        start: async (showToast = true) => {
            try {
                if (showToast) createToast("启动 UU 路由插件中...", "yellow");
                await appendInstallLog(`start_clicked version=${SCRIPT_VERSION}`);
                const patchStartRes = await patchPidPathInBinary();
                await appendInstallLog(`pid_path_patch(start): ${patchStartRes.content || "empty"}`);
                const ok = await startCore();
                await appendInstallLog(`start_core: ${ok ? "ok" : "failed"}`);
                await wait(1800);
                if (await isRunning()) createToast("UU 路由插件已启动", "green");
                else createToast("进程未驻留，请查看日志", "red");
            } catch (e) {
                await appendInstallLog(`start_exception: ${e && e.message ? e.message : String(e)}`);
                createToast(`启动异常: ${e && e.message ? e.message : e}`, "red");
            }
            refreshState();
        },

        stop: async () => {
            createToast("停止中...", "yellow");
            await stopCore();
            await wait(600);
            createToast("已停止", "green");
            refreshState();
        },

        restart: async () => {
            await stopCore();
            await wait(800);
            await actions.start(false);
        },

        uninstall: async () => {
            if (!confirm("确定卸载 UU 路由插件吗？")) return;
            await stopCore();
            await runCMD(`rm -rf ${PLUGIN_DIR}`);
            await runCMD(`touch ${BOOT_SH}; grep -vxF '${BOOT_SCRIPT}' ${BOOT_SH} > ${BOOT_SH}.tmp || true; cat ${BOOT_SH}.tmp > ${BOOT_SH}; rm -f ${BOOT_SH}.tmp`);
            createToast("卸载完成", "green");
            refreshState();
        },

        toggleBoot: async () => {
            const now = await isBootUp();
            if (now) {
                await runCMD(`touch ${BOOT_SH}; grep -vxF '${BOOT_SCRIPT}' ${BOOT_SH} > ${BOOT_SH}.tmp || true; cat ${BOOT_SH}.tmp > ${BOOT_SH}; rm -f ${BOOT_SH}.tmp`);
                createToast("已关闭开机自启", "green");
            } else {
                const ok = await createBootScript();
                if (!ok) return createToast("启动脚本创建失败", "red");
                await runCMD(`touch ${BOOT_SH}; grep -qxF '${BOOT_SCRIPT}' ${BOOT_SH} || echo '${BOOT_SCRIPT}' >> ${BOOT_SH}`);
                createToast("已开启开机自启", "green");
            }
            refreshState();
        },

        showLog: async () => {
            const install = await runCMD(`if [ -f ${INSTALL_LOG_FILE} ]; then tail -n 240 ${INSTALL_LOG_FILE}; else echo "暂无安装日志"; fi`, 25000);
            const runtime = await runCMD(`if [ -f ${LOG_FILE} ]; then tail -n 200 ${LOG_FILE}; else echo "暂无运行日志"; fi`, 25000);
            const message = [
                "===== 安装日志 =====",
                install.content || "暂无安装日志",
                "",
                "===== 运行日志 =====",
                runtime.content || "暂无运行日志",
            ].join("\n").replaceAll("\n", "<br>");

            const { el, close } = createFixedToast("uu_route_log_toast", `
                <div style="pointer-events:all;width:80vw;max-width:900px;">
                    <div class="title" style="margin:0">UU路由插件日志</div>
                    <div id="uu_route_log_box" style="margin:10px 0;max-height:420px;overflow:auto;font-size:.62rem;line-height:1.4;">${message}</div>
                    <div style="text-align:right">
                        <button style="font-size:.64rem" id="uu_route_log_close_btn" data-i18n="close_btn">关闭</button>
                    </div>
                </div>
            `);
            el.querySelector("#uu_route_log_close_btn").onclick = close;
        },

        coreInfo: async () => {
            createToast("读取 UU 核心信息中...", "yellow");
            const [installed, running, pidPathRes, coreVerRes, logVerRes, binMd5Res, binSizeRes, pidRes, psRes, confMd5Res, confSizeRes, srcRes] = await Promise.all([
                isInstalled().then((ok) => ok ? "yes" : "no"),
                isRunning().then((ok) => ok ? "yes" : "no"),
                runCMD(`if grep -a "${PID_PATH_PATCHED}" ${PLUGIN_EXEC} >/dev/null 2>&1; then echo "patched:${PID_PATH_PATCHED}"; elif grep -a "${PID_PATH_PATCHED_OLD}" ${PLUGIN_EXEC} >/dev/null 2>&1; then echo "old_patched:${PID_PATH_PATCHED_OLD}"; elif grep -a "${PID_PATH_ORIG}" ${PLUGIN_EXEC} >/dev/null 2>&1; then echo "orig:${PID_PATH_ORIG}"; else echo "unknown"; fi`),
                runCMD(`if [ -x ${PLUGIN_EXEC} ]; then strings ${PLUGIN_EXEC} 2>/dev/null | grep -Eo 'v[0-9]+\\.[0-9]+\\.[0-9]+' | head -n 1; else echo "not_installed"; fi`, 20000),
                runCMD(`if [ -f ${INSTALL_LOG_FILE} ]; then grep -Eo 'v[0-9]+\\.[0-9]+\\.[0-9]+' ${INSTALL_LOG_FILE} | tail -n 1; else echo "no_install_log"; fi`),
                runCMD(`if [ -f ${PLUGIN_EXEC} ]; then (md5sum ${PLUGIN_EXEC} 2>/dev/null | awk '{print $1}') || echo "md5sum_unavailable"; else echo "not_found"; fi`),
                runCMD(`if [ -f ${PLUGIN_EXEC} ]; then (wc -c < ${PLUGIN_EXEC} 2>/dev/null | tr -d ' \n'); else echo "not_found"; fi`),
                runCMD(`pidof uuplugin 2>/dev/null || echo "not_running"`),
                runCMD(`ps -ef | grep uuplugin | grep -v grep | head -n 2 || echo "not_running"`),
                runCMD(`if [ -f ${PLUGIN_CONF} ]; then (md5sum ${PLUGIN_CONF} 2>/dev/null | awk '{print $1}') || echo "md5sum_unavailable"; else echo "not_found"; fi`),
                runCMD(`if [ -f ${PLUGIN_CONF} ]; then (wc -c < ${PLUGIN_CONF} 2>/dev/null | tr -d ' \n'); else echo "not_found"; fi`),
                runCMD(`if [ -f ${INSTALL_LOG_FILE} ]; then grep -E '命中接口:|下载信息:|开始下载主链接:' ${INSTALL_LOG_FILE} | tail -n 6; else echo "no_install_log"; fi`, 12000),
            ]);

            const coreVersion = firstLine(coreVerRes.content) || firstLine(logVerRes.content) || "unknown";
            const text = `
脚本版本: ${SCRIPT_VERSION}
官方静态包版本: ${STATIC_FALLBACK_VERSION}
核心版本(探测): ${coreVersion}
已安装: ${installed}
运行中: ${running}
PID路径模式: ${oneLine(pidPathRes.content || "unknown")}
进程PID: ${oneLine(pidRes.content || "not_running")}
进程摘要:
${(psRes.content || "").trim() || "not_running"}
核心文件: ${PLUGIN_EXEC}
核心大小(bytes): ${oneLine(binSizeRes.content || "unknown")}
核心MD5: ${oneLine(binMd5Res.content || "unknown")}
配置文件: ${PLUGIN_CONF}
配置大小(bytes): ${oneLine(confSizeRes.content || "unknown")}
配置MD5: ${oneLine(confMd5Res.content || "unknown")}
最近安装来源:
${(srcRes.content || "").trim() || "no_install_log"}
            `.trim();

            const { el, close } = createFixedToast("uu_core_info_toast", `
                <div style="pointer-events:all;width:80vw;max-width:920px;">
                    <div class="title" style="margin:0">UU核心信息</div>
                    <pre id="uu_core_info_box" style="margin:10px 0;max-height:420px;overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:.62rem;line-height:1.4;"></pre>
                    <div style="text-align:right">
                        <button style="font-size:.64rem" id="uu_core_info_close_btn" data-i18n="close_btn">关闭</button>
                    </div>
                </div>
            `);
            const box = el.querySelector("#uu_core_info_box");
            if (box) box.textContent = text;
            el.querySelector("#uu_core_info_close_btn").onclick = close;
        },

        checkEnv: async () => {
            const [archRes, tunRes, iptRes, nftRes, ipfRes, varRunRes, pidFileRes, pidPathRes, installedStatus, runningStatus] = await Promise.all([
                runCMD("uname -m"),
                runCMD(`if [ -c /dev/tun ] || [ -c /dev/net/tun ]; then echo yes; else echo no; fi`),
                runCMD("which iptables || echo not_found"),
                runCMD("which nft || echo not_found"),
                runCMD("sysctl net.ipv4.ip_forward 2>/dev/null || cat /proc/sys/net/ipv4/ip_forward 2>/dev/null || echo unknown"),
                runCMD(`ls -ld /var /var/run 2>/dev/null || echo "/var/run not accessible"`),
                runCMD(`if [ -f ${PID_FILE} ]; then echo "exists:$(cat ${PID_FILE} 2>/dev/null)"; else echo "not_found"; fi`),
                runCMD(`if grep -a "${PID_PATH_PATCHED}" ${PLUGIN_EXEC} >/dev/null 2>&1; then echo "patched:${PID_PATH_PATCHED}"; elif grep -a "${PID_PATH_PATCHED_OLD}" ${PLUGIN_EXEC} >/dev/null 2>&1; then echo "old_patched:${PID_PATH_PATCHED_OLD}"; elif grep -a "${PID_PATH_ORIG}" ${PLUGIN_EXEC} >/dev/null 2>&1; then echo "orig:${PID_PATH_ORIG}"; else echo "unknown"; fi`),
                isInstalled().then((ok) => ok ? "yes" : "no"),
                isRunning().then((ok) => ok ? "yes" : "no"),
            ]);
            const text = `
架构: ${(archRes.content || "unknown").trim()}
/dev/tun: ${(tunRes.content || "unknown").trim()}
iptables: ${(iptRes.content || "unknown").trim()}
nft: ${(nftRes.content || "unknown").trim()}
ip_forward: ${(ipfRes.content || "unknown").trim()}
var_run: ${(varRunRes.content || "unknown").trim()}
legacy_pid_file: ${(pidFileRes.content || "unknown").trim()}
binary_pid_path: ${(pidPathRes.content || "unknown").trim()}
已安装: ${installedStatus}
运行中: ${runningStatus}
            `.trim();
            const { el, close } = createFixedToast("uu_env_check_toast", `
                <div style="pointer-events:all;width:80vw;max-width:780px;">
                    <div class="title" style="margin:0">UU环境检测</div>
                    <pre style="margin:10px 0;white-space:pre-wrap;word-break:break-all;font-size:.62rem;line-height:1.4;">${text}</pre>
                    <div style="text-align:right">
                        <button style="font-size:.64rem" id="uu_env_check_close_btn" data-i18n="close_btn">关闭</button>
                    </div>
                </div>
            `);
            const closeBtn = el.querySelector("#uu_env_check_close_btn");
            if (closeBtn) closeBtn.onclick = close;
        },
    };

    (async () => {
        window.__UFI_UU_SCRIPT_VERSION = SCRIPT_VERSION;
        console.log(`[UFI-UU] script loaded version=${SCRIPT_VERSION}`);

        while (!window.UFI_DATA || !UFI_DATA.lan_ipaddr) await wait(200);
        const container = document.querySelector(".functions-container");
        if (!container) return;

        container.insertAdjacentHTML("afterend", `
            <div id="IFRAME_UU_ROUTE" style="width:100%;margin-top:10px;">
                <div class="title" style="margin:6px 0;display:flex;align-items:center;">
                    <strong id="running_uu">UU主机加速</strong>
                    <div style="display:inline-block;margin-left:8px;" id="collapse_uu_btn"></div>
                </div>
                <div class="collapse" id="collapse_uu" style="height:0;overflow:hidden;">
                    <div class="collapse_box">
                        <div id="uu_action_box" style="padding:10px;display:flex;gap:10px;flex-wrap:wrap;"></div>
                    </div>
                </div>
            </div>
        `);

        const box = document.getElementById("uu_action_box");
        const createBtn = (text, onClick, id) => {
            const btn = document.createElement("button");
            btn.className = "btn";
            btn.textContent = text;
            if (id) btn.id = id;
            btn.onclick = async () => {
                if (!await checkRoot()) return createToast("需要 Root 权限", "red");
                await onClick(btn);
            };
            box.appendChild(btn);
            return btn;
        };

        createBtn("安装", actions.install, "btn_uu_install");
        createBtn("启动", actions.start, "btn_uu_start");
        createBtn("停止", actions.stop, "btn_uu_stop");
        createBtn("重启", actions.restart, "btn_uu_restart");
        createBtn("卸载", actions.uninstall, "btn_uu_uninstall");
        createBtn("开机自启", actions.toggleBoot, "btn_uu_boot");
        createBtn("核心信息", actions.coreInfo, "btn_uu_core");
        createBtn("查看日志", actions.showLog, "btn_uu_log");
        createBtn("环境检测", actions.checkEnv, "btn_uu_check");

        collapseGen("#collapse_uu_btn", "#collapse_uu", "#collapse_uu", (state) => {
            if (state === "open") refreshState();
        });

        if (localStorage.getItem("#collapse_uu") === "open") refreshState();
        setTimeout(refreshState, 800);
    })();
})();
//</script>

