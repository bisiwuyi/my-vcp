// AdminPanel/script.js
import { apiFetch, showMessage, checkAuthStatus } from './js/utils.js';
import { parseEnvToList, buildEnvString, createFormGroup, createCommentOrEmptyElement } from './js/config.js';
import { loadPluginList, loadPluginConfig } from './js/plugins.js';
import { initializeDashboard, stopDashboardUpdates } from './js/dashboard.js';
import { initializeDailyNotesManager } from './js/notes-manager.js';
import { initializeAgentManager } from './js/agent-manager.js';
import { initializeAgentAssistantConfig } from './js/agent-assistant-config.js';
import { initializeToolboxManager } from './js/toolbox-manager.js';
import { initializeTvsFilesEditor } from './js/tvs-editor.js';
import { initializeServerLogViewer, stopServerLogUpdates } from './js/log-viewer.js';
import { initializePreprocessorOrderManager } from './js/preprocessor-manager.js';
import { initializeSemanticGroupsEditor } from './js/semantic-groups-editor.js';
import { initializeThinkingChainsEditor } from './js/thinking-chains-editor.js';
import { initializeVCPForum } from './js/forum.js';
import { initializeScheduleManager } from './js/schedule-manager.js';
import { initializeRAGTuning } from './js/rag-tuning.js';
import { initializeDreamManager } from './js/dream-manager.js';
import { initializeAgentScores } from './js/agent-scores.js';
import { initializePlaceholderViewer } from './js/placeholder-viewer.js';
import { initializeToolApprovalManager } from './js/tool-approval.js';

document.addEventListener('DOMContentLoaded', async () => {
    // 1. 通过后端验证登录状态（替代前端 Cookie 检查，解决 HttpOnly 无法读取问题）
    const isAuthenticated = await checkAuthStatus();
    if (!isAuthenticated) {
        console.warn('Not authenticated, redirecting to login...');
        window.location.href = '/AdminPanel/login.html';
        return;
    }

    const pluginNavList = document.getElementById('plugin-nav')?.querySelector('ul');
    const baseConfigForm = document.getElementById('base-config-form');
    const restartServerButton = document.getElementById('restart-server-button');
    const sidebarSearchInput = document.getElementById('sidebar-search');

    const API_BASE_URL = '/admin_api';
    let originalBaseConfigEntries = [];

    /**
     * 清理所有 iframe 内部的状态，防止滚动条锁定等问题。
     */
    function cleanupIframeStates() {
        const iframes = document.querySelectorAll('iframe');
        iframes.forEach(iframe => {
            try {
                const iframeWindow = iframe.contentWindow;
                const iframeDoc = iframe.contentDocument || iframeWindow?.document;
                if (iframeDoc) {
                    // 尝试调用 iframe 内部可能存在的 closeModal 函数
                    if (iframeWindow && typeof iframeWindow.closeModal === 'function') {
                        iframeWindow.closeModal();
                    } else {
                        // 备选方案：手动清理常见的 Modal 标识
                        const modal = iframeDoc.getElementById('mediaModal') || iframeDoc.querySelector('.modal');
                        if (modal) {
                            modal.style.display = 'none';
                        }
                        iframeDoc.body.style.overflow = '';
                        iframeDoc.documentElement.style.overflow = '';
                    }
                }
            } catch (e) {
                // 跨域安全限制时会报错，忽略即可
            }
        });
        // 强制恢复主页面滚动状态
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
    }

    /**
     * 主导航函数，根据 target 激活对应的功能模块。
     * @param {string} dataTarget - 导航链接的 data-target 属性值
     */
    function navigateTo(dataTarget) {
        const sectionIdToActivate = `${dataTarget}-section`;
        const pluginName = document.querySelector(`a[data-target="${dataTarget}"]`)?.dataset.pluginName;

        // 停止可能正在运行的定时器
        stopDashboardUpdates();
        stopServerLogUpdates();

        // 切换导航链接状态
        document.querySelectorAll('.sidebar nav li a').forEach(link => link.classList.remove('active'));
        const activeLink = document.querySelector(`a[data-target="${dataTarget}"]`);
        if (activeLink) activeLink.classList.add('active');

        // 处理所有 section 的显示隐藏及 iframe 懒加载/卸载
        document.querySelectorAll('.config-section').forEach(section => {
            const isTarget = section.id === sectionIdToActivate;
            const iframe = section.querySelector('iframe');

            if (isTarget) {
                section.classList.add('active-section');
                // 懒加载：进入时加载 iframe
                if (iframe && iframe.dataset.src && (!iframe.src || iframe.src === 'about:blank' || !iframe.src.includes(iframe.dataset.src))) {
                    iframe.src = iframe.dataset.src;
                    // 确保宽度撑满
                    iframe.style.width = '100%';
                }
            } else {
                // 离开时卸载 iframe，彻底销毁其 DOM 和状态（如 overflow:hidden）
                if (section.classList.contains('active-section')) {
                    if (iframe && iframe.src && iframe.src !== 'about:blank') {
                        iframe.src = 'about:blank';
                    }
                }
                section.classList.remove('active-section');
            }
        });

        const targetSection = document.getElementById(sectionIdToActivate);
        if (targetSection) {
            // 根据 sectionId 初始化对应的模块
            if (pluginName) {
                loadPluginConfig(pluginName).catch(err => console.error(`Failed to load config for ${pluginName}`, err));
            } else {
                switch (sectionIdToActivate) {
                    case 'dashboard-section':
                        initializeDashboard();
                        break;
                    case 'daily-notes-manager-section':
                        initializeDailyNotesManager();
                        break;
                    case 'agent-files-editor-section':
                        initializeAgentManager();
                        break;
                    case 'agent-assistant-config-section':
                        initializeAgentAssistantConfig();
                        break;
                    case 'agent-scores-section':
                        initializeAgentScores();
                        break;
                    case 'toolbox-manager-section':
                        initializeToolboxManager();
                        break;
                    case 'tvs-files-editor-section':
                        initializeTvsFilesEditor();
                        break;
                    case 'server-log-viewer-section':
                        initializeServerLogViewer();
                        break;
                    case 'preprocessor-order-manager-section':
                        initializePreprocessorOrderManager();
                        break;
                    case 'semantic-groups-editor-section':
                        initializeSemanticGroupsEditor();
                        break;
                    case 'thinking-chains-editor-section':
                        initializeThinkingChainsEditor();
                        break;
                    case 'vcp-forum-section':
                        initializeVCPForum();
                        break;
                    case 'schedule-manager-section':
                        initializeScheduleManager();
                        break;
                    case 'rag-tuning-section':
                        initializeRAGTuning();
                        break;
                    case 'dream-manager-section':
                        initializeDreamManager();
                        break;
                    case 'placeholder-viewer-section':
                        initializePlaceholderViewer();
                        break;
                    case 'tool-approval-manager-section':
                        initializeToolApprovalManager();
                        break;
                }
            }
        } else {
            console.warn(`[navigateTo] Target section with ID '${sectionIdToActivate}' not found.`);
        }

        // 强制重置主内容区域滚动条
        const contentArea = document.getElementById('config-details-container');
        if (contentArea) {
            contentArea.scrollTo(0, 0);
        }
        // 额外保险：恢复 body 滚动
        document.body.style.overflow = '';
        document.documentElement.style.overflow = '';
    }

    /**
     * 加载全局配置。
     */
    const VTPBROKER_CONFIG_KEYS = [
        'ENABLE_BUILTIN_VTBROKER',
        'BUILTIN_VTBROKER_PORT',
        'VTBROKER_ENABLE_FUZZY_MATCH',
        'VTBROKER_MAX_RESULTS'
    ];

    function isVTPBrokerConfigKey(key) {
        return VTPBROKER_CONFIG_KEYS.includes(key);
    }

    async function loadBaseConfig() {
        if (!baseConfigForm) return;
        try {
            const data = await apiFetch(`${API_BASE_URL}/config/main`);
            originalBaseConfigEntries = parseEnvToList(data.content);
            
            baseConfigForm.innerHTML = '';
            
            const vtbrokerConfigGroup = document.createElement('div');
            vtbrokerConfigGroup.id = 'vtbroker-config-group';
            vtbrokerConfigGroup.className = 'config-group';
            vtbrokerConfigGroup.style.display = 'none';
            
            const vtbrokerConfigHeader = document.createElement('h3');
            vtbrokerConfigHeader.textContent = '内置 VTPBroker (工具发现中间件)';
            vtbrokerConfigGroup.appendChild(vtbrokerConfigHeader);
            
            const vtbrokerConfigDesc = document.createElement('div');
            vtbrokerConfigDesc.className = 'config-group-description';
            vtbrokerConfigDesc.textContent = 'VTPBroker 提供工具枚举、搜索、Schema获取功能。开启内置模式后可获得更快的元数据同步和高级特性（热度统计、渐进式披露、插件注意点注入）。';
            vtbrokerConfigGroup.appendChild(vtbrokerConfigDesc);
            
            const vtbrokerStatusDiv = document.createElement('div');
            vtbrokerStatusDiv.id = 'vtbroker-status';
            vtbrokerStatusDiv.className = 'vtbroker-status';
            vtbrokerStatusDiv.innerHTML = '<span class="vtbroker-status-label">当前模式：</span><span class="vtbroker-status-value">加载中...</span>';
            vtbrokerConfigGroup.appendChild(vtbrokerStatusDiv);
            
            const vtbrokerConfigItems = document.createElement('div');
            vtbrokerConfigItems.id = 'vtbroker-config-items';
            const nonVtbrokerEntries = [];

            originalBaseConfigEntries.forEach((entry, index) => {
                let formGroup;
                if (entry.isCommentOrEmpty) {
                    formGroup = createCommentOrEmptyElement(entry.value, index);
                    nonVtbrokerEntries.push({ entry, formGroup, index });
                } else if (isVTPBrokerConfigKey(entry.key)) {
                    let inferredType = 'string';
                    if (/^(true|false)$/i.test(entry.value)) inferredType = 'boolean';
                    else if (!isNaN(parseFloat(entry.value)) && isFinite(entry.value) && !entry.value.includes('.')) inferredType = 'integer';

                    formGroup = createFormGroup(
                        entry.key, entry.value, inferredType,
                        `VTPBroker 配置: ${entry.key}`,
                        false, null, false, entry.isMultilineQuoted
                    );
                    vtbrokerConfigItems.appendChild(formGroup);
                } else {
                    let inferredType = 'string';
                    if (/^(true|false)$/i.test(entry.value)) inferredType = 'boolean';
                    else if (!isNaN(parseFloat(entry.value)) && isFinite(entry.value) && !entry.value.includes('.')) inferredType = 'integer';

                    formGroup = createFormGroup(
                        entry.key, entry.value, inferredType,
                        `根目录 config.env 配置项: ${entry.key}`,
                        false, null, false, entry.isMultilineQuoted
                    );
                    nonVtbrokerEntries.push({ entry, formGroup, index });
                }
            });

            vtbrokerConfigGroup.appendChild(vtbrokerConfigItems);
            if (vtbrokerConfigItems.children.length > 0) {
                vtbrokerConfigGroup.style.display = 'block';
            }
            baseConfigForm.appendChild(vtbrokerConfigGroup);

            nonVtbrokerEntries.forEach(({ formGroup }) => {
                baseConfigForm.appendChild(formGroup);
            });

            const actionsDiv = document.createElement('div');
            actionsDiv.className = 'form-actions';
            actionsDiv.innerHTML = `<button type="submit">保存全局配置</button>`;
            baseConfigForm.appendChild(actionsDiv);
            
            fetch('/vtbroker/api/status')
                .then(res => res.json())
                .then(data => {
                    if (data.success) {
                        const statusDiv = document.getElementById('vtbroker-status');
                        if (statusDiv) {
                            const modeClass = data.mode === 'builtin' ? 'mode-builtin' : 'mode-standalone';
                            const modeIcon = data.mode === 'builtin' ? '🔧' : '📦';
                            statusDiv.innerHTML = `
                                <span class="vtbroker-status-label">当前模式：</span>
                                <span class="vtbroker-status-badge ${modeClass}">${modeIcon} ${data.modeDescription}</span>
                                <span class="vtbroker-status-tools">（${data.totalTools} 个工具）</span>
                            `;
                        }
                    }
                })
                .catch(() => {});
        } catch (error) {
            baseConfigForm.innerHTML = `<p class="error-message">加载全局配置失败: ${error.message}</p>`;
        }
    }

    /**
     * 检测 VTPBroker 配置是否发生变化。
     * @returns {boolean} - 是否有变化
     */
    function hasVTPBrokerConfigChanged() {
        const vtbrokerKeys = ['ENABLE_BUILTIN_VTBROKER', 'BUILTIN_VTBROKER_PORT', 'VTBROKER_ENABLE_FUZZY_MATCH', 'VTBROKER_MAX_RESULTS'];
        
        for (const key of vtbrokerKeys) {
            const entry = originalBaseConfigEntries.find(e => e.key === key && !e.isCommentOrEmpty);
            if (!entry) continue;
            
            const inputElement = baseConfigForm.querySelector(`[data-original-key="${key}"]`);
            if (!inputElement) continue;
            
            let currentValue;
            if (inputElement.type === 'checkbox') {
                currentValue = inputElement.checked ? 'true' : 'false';
            } else {
                currentValue = inputElement.value;
            }
            
            if (currentValue !== entry.value) {
                return true;
            }
        }
        return false;
    }

    /**
     * 显示 VTPBroker 重启提示横幅。
     */
    function showVTPBrokerRestartBanner() {
        const existingBanner = document.getElementById('vtbroker-restart-banner');
        if (existingBanner) existingBanner.remove();
        
        const banner = document.createElement('div');
        banner.id = 'vtbroker-restart-banner';
        banner.className = 'vtbroker-restart-banner';
        banner.innerHTML = `
            <div class="vtbroker-restart-banner-content">
                <span class="vtbroker-restart-banner-icon">⚠️</span>
                <span class="vtbroker-restart-banner-text">VTPBroker 配置已更改，需要 <strong>重启服务</strong> 才能生效。</span>
                <button id="vtbroker-restart-now-btn" class="vtbroker-restart-now-btn">立即重启</button>
                <button id="vtbroker-restart-dismiss-btn" class="vtbroker-restart-dismiss-btn">稍后</button>
            </div>
        `;
        
        const vtbrokerGroup = document.getElementById('vtbroker-config-group');
        if (vtbrokerGroup) {
            vtbrokerGroup.insertAdjacentElement('afterend', banner);
        } else {
            baseConfigForm.insertBefore(banner, baseConfigForm.firstChild);
        }
        
        document.getElementById('vtbroker-restart-now-btn').addEventListener('click', async () => {
            await restartServer();
            banner.remove();
        });
        
        document.getElementById('vtbroker-restart-dismiss-btn').addEventListener('click', () => {
            banner.remove();
        });
    }

    /**
     * 处理全局配置表单提交。
     * @param {Event} event - 提交事件
     */
    async function handleBaseConfigSubmit(event) {
        event.preventDefault();
        const newConfigString = buildEnvString(baseConfigForm, originalBaseConfigEntries);
        const vtbrokerChanged = hasVTPBrokerConfigChanged();
        
        try {
            await apiFetch(`${API_BASE_URL}/config/main`, {
                method: 'POST',
                body: JSON.stringify({ content: newConfigString })
            });
            
            if (vtbrokerChanged) {
                showVTPBrokerRestartBanner();
                showMessage('全局配置已保存！VTPBroker 配置变更需要重启服务。', 'warning', 5000);
            } else {
                showMessage('全局配置已保存！部分更改可能需要重启服务生效。', 'success');
            }
            loadBaseConfig();
        } catch (error) { /* Error handled by apiFetch */ }
    }

    /**
     * 重启服务器。
     */
    async function restartServer() {
        if (!confirm('您确定要重启服务器吗？')) return;
        try {
            showMessage('正在发送重启服务器命令...', 'info');
            const response = await apiFetch(`${API_BASE_URL}/server/restart`, { method: 'POST' });
            const message = response?.message || (typeof response === 'string' && response.includes('重启命令已发送') ? response : '服务器重启命令已发送。请稍后检查服务器状态。');
            showMessage(message, 'success', 5000);
        } catch (error) {
            console.error('Restart server failed:', error);
        }
    }

    /**
     * 过滤侧边栏导航项。
     */
    function filterSidebar() {
        const searchTerm = sidebarSearchInput.value.toLowerCase().trim();
        const navLinks = document.querySelectorAll('#plugin-nav li a');
        const categories = document.querySelectorAll('#plugin-nav li.nav-category');

        navLinks.forEach(link => {
            const linkText = link.textContent.toLowerCase();
            const parentLi = link.parentElement;
            parentLi.style.display = linkText.includes(searchTerm) ? '' : 'none';
        });

        categories.forEach(category => {
            let nextElement = category.nextElementSibling;
            let allHidden = true;
            while (nextElement && !nextElement.classList.contains('nav-category')) {
                if (nextElement.style.display !== 'none') {
                    allHidden = false;
                    break;
                }
                nextElement = nextElement.nextElementSibling;
            }
            category.style.display = allHidden ? 'none' : '';
        });
    }

    /**
     * 加载所有初始数据。
     */
    async function loadInitialData() {
        try {
            await loadBaseConfig();
            await loadPluginList();
            const firstLink = pluginNavList.querySelector('a');
            if (firstLink) {
                navigateTo(firstLink.dataset.target);
                firstLink.classList.add('active');
            }
        } catch (error) { /* Error already shown by apiFetch */ }
    }

    // --- Event Listeners ---
    if (pluginNavList) {
        pluginNavList.addEventListener('click', (event) => {
            const anchor = event.target.closest('a');
            if (anchor) {
                event.preventDefault();
                navigateTo(anchor.dataset.target);
            }
        });
    }
    if (baseConfigForm) {
        baseConfigForm.addEventListener('submit', handleBaseConfigSubmit);
    }
    if (restartServerButton) {
        restartServerButton.addEventListener('click', restartServer);
    }
    if (sidebarSearchInput) {
        sidebarSearchInput.addEventListener('input', filterSidebar);
    }

    // --- Initial Load ---
    loadInitialData();
});
