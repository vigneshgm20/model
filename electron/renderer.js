// renderer.js - COMPLETE (unified format, persistent history, color-only bold)
document.addEventListener("DOMContentLoaded", function () {
    console.log("🚀 Interview Helper Frontend Initializing...");

    /* ============ STATE ============ */
    let sseConnection = null;
    let currentTranscript = "";
    let micMuted = false;
    let systemMuted = false;
    let isAiResponding = false;
    let sessionTimer = null;
    let sessionStartTime = null;
    let currentSessionId = null;
    let isSessionActive = false;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 10;

    let lastProcessedText = "";
    let lastProcessedTime = 0;
    let lastPartialText = "";
    let lastFinalText = "";
    let duplicateBlockList = new Set();

    let isAutoScrollEnabled = false;
    let pendingChatImage = null;
    let isCapturingForChat = false;

    // Live interviewer text (for screenshot capture)
    let liveInterviewerText = "";
    let liveInterviewerTimestamp = 0;

    // Track which code block was last copied (for cycling)
    let _lastCopiedCodeIdx = -1;

    /* Q&A navigation history */
    let qaHistory = [];
    let qaHistoryIndex = -1;

    /* Bullet-mode for the currently generating answer */
    let currentBulletMode = false;

    /* ============ ELEMENTS ============ */
    const qaQuestion = document.getElementById("qaQuestion");
    const qaAnswer = document.getElementById("qaAnswer");
    const btnAnswer = document.getElementById("btnAnswer");
    const btnPrevQ = document.getElementById("btnPrevQ");
    const btnNextQ = document.getElementById("btnNextQ");
    const qaCounter = document.getElementById("qaCounter");
    const btnClear = document.getElementById("btnClear");
    const btnMic = document.getElementById("btnMicIcon");
    const btnSystem = document.getElementById("btnSystemIcon");
    const btnBackToSettings = document.getElementById("btnBackToSettings");
    const btnToolbarCancel = document.getElementById("btnToolbarCancel");
    const btnCollapse = document.getElementById("toolbarCollapse");
    const durationLabel = document.getElementById("durationLabel");
    const toolbarDuration = document.getElementById("toolbarDuration");

    const companyInput = document.getElementById("companyInput");
    const jobDescInput = document.getElementById("jobDescInput");
    const resumeText = document.getElementById("resumeText");
    const contextInput = document.getElementById("contextInput");

    const tabs = document.querySelectorAll(".tab");
    const tabPanels = document.querySelectorAll(".tab-panel");

    const chatInput = document.getElementById("chatInput");
    const btnSendChat = document.getElementById("chatSend");
    const toolbarChat = document.getElementById("toolbarChat");
    const chatBar = document.getElementById("chatBar");
    const chatBarClose = document.getElementById("chatBarClose");
    const chatAttachmentPreview = document.getElementById("chatAttachmentPreview");
    const chatAttachmentRemove  = document.getElementById("chatAttachmentRemove");
    const toolbarScreenshot     = document.getElementById("toolbarScreenshot");

    const sessionList = document.getElementById("sessionList");
    const sessionMeta = document.getElementById("sessionMeta");
    const sessionMessages = document.getElementById("sessionMessages");

    const windowShell = document.getElementById("windowShell");
    const aiToolbar = document.getElementById("aiToolbar");
    const aiPanel = document.getElementById("aiPanel");

    /* ============ UNIFIED ANSWER FORMATTER ============ */

    function escapeHtml(text) {
        const d = document.createElement('div');
        d.textContent = text == null ? '' : String(text);
        return d.innerHTML;
    }

    /* Inline markdown: **bold** → colored-only bold; `code` → inline code */
    function renderInline(text) {
        if (!text) return '';
        const parts = String(text).split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
        let out = '';
        for (const part of parts) {
            if (!part) continue;
            if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
                out += `<span class="md-bold">${escapeHtml(part.slice(2, -2))}</span>`;
            } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
                out += `<code class="inline-code">${escapeHtml(part.slice(1, -1))}</code>`;
            } else {
                out += escapeHtml(part);
            }
        }
        return out;
    }

    /* Split a paragraph into sentences. Keeps punctuation. */
    function splitIntoSentences(text) {
        if (!text) return [];
        const t = text.trim();
        if (!t) return [];
        const parts = t.split(/(?<=[.!?])\s+(?=[A-Z0-9"'\u2018\u201C(])/);
        return parts.map(s => s.trim()).filter(Boolean);
    }

    /* Turn the raw accumulated stream text into final HTML.
       Same function is used during streaming, at completion, and when
       restoring from history — guaranteeing identical formatting. */
    function formatAnswerHtml(rawText, options) {
        const opts = options || {};
        const wantBullets = !!opts.bulletMode;

        if (!rawText) return '';

        const lines = String(rawText).split('\n');
        let html = '';
        let i = 0;

        while (i < lines.length) {
            const line = lines[i];
            const trimmed = line.trim();

            if (!trimmed) { i++; continue; }

            /* ---- Fenced code block ``` ---- */
            if (trimmed.startsWith('```')) {
                const lang = trimmed.slice(3).trim() || 'code';
                const codeLines = [];
                i++;
                while (i < lines.length && !lines[i].trim().startsWith('```')) {
                    codeLines.push(lines[i]);
                    i++;
                }
                i++; // skip closing ```
                const codeText = codeLines.join('\n');
                html += (
                    `<div class="chatgpt-code-block">` +
                        `<div class="code-header">` +
                            `<span class="code-language">${escapeHtml(lang)}</span>` +
                            `<button class="copy-button" type="button">Copy code</button>` +
                        `</div>` +
                        `<pre><code class="language-${escapeHtml(lang)}">${escapeHtml(codeText)}</code></pre>` +
                    `</div>`
                );
                continue;
            }

            /* ---- Explicit bullet: "- ", "* ", "• ", "1. " ---- */
            const bulletMatch = trimmed.match(/^(?:[-*•]|\d+\.)\s+(.*)$/);
            if (bulletMatch) {
                html += `<div class="bullet-item"><span class="bullet-dot">•</span><span class="bullet-text">${renderInline(bulletMatch[1])}</span></div>`;
                i++;
                continue;
            }

            /* ---- Paragraph (optionally split into sentence bullets) ---- */
            if (wantBullets) {
                const sentences = splitIntoSentences(trimmed);
                for (const s of sentences) {
                    html += `<div class="bullet-item"><span class="bullet-dot">•</span><span class="bullet-text">${renderInline(s)}</span></div>`;
                }
            } else {
                html += `<div class="paragraph">${renderInline(trimmed)}</div>`;
            }
            i++;
        }

        return html;
    }

    /* Render accumulated raw text into a container. Idempotent. */
    function renderAnswer(container, rawText, options) {
        if (!container) return;
        if (!rawText) {
            if (!container.querySelector('.thinking')) {
                container.innerHTML = '<div class="thinking">Receiving...</div>';
            }
            return;
        }
        container.innerHTML = formatAnswerHtml(rawText, options || {});
        wireCodeBlockCopyButtons(container);
    }

    /* Back-compat shims so any existing call sites keep working. */
    function renderStreamingAnswer(container, text) {
        renderAnswer(container, text, { bulletMode: currentBulletMode });
    }

    function finalizeStreamingAnswer(container, text) {
        renderAnswer(container, text, { bulletMode: currentBulletMode });
    }

    /* Whether the current answer should be rendered as per-sentence bullets. */
    function detectBulletMode(userText) {
        if (!userText) return false;
        const t = String(userText).toLowerCase();
        return (
            /\bbullet(s)?\b/.test(t) ||
            /\beach sentence\b/.test(t) ||
            /\bpoint(s)?\s*(wise|form|format)\b/.test(t) ||
            /\blist format\b/.test(t) ||
            /\bper sentence\b/.test(t)
        );
    }

    /* ============ CURSOR CONTROL ============ */
    function setupCursorControl() {
        console.log("🖱️ Cursor control active");
        const style = document.createElement('style');
        style.id = 'cursor-control-style';
        style.textContent = `
            * { cursor: default !important; }
            button, .tab, .ctrl, .circle-icon, .square-icon, .pill,
            .nav-btn, .primary-btn, .secondary-btn, a, .session-item,
            [role="button"], [type="button"], [type="submit"],
            #toolbarChat, #chatSend, #btnMin, #btnClose,
            #btnToolbarCancel, #toolbarCollapse,
            #btnPrevQ, #btnNextQ {
                cursor: default !important;
            }
            input, textarea, .chat-input, [contenteditable="true"] {
                cursor: text !important;
            }
            body.screen-sharing, body.screen-sharing * { cursor: none !important; }
        `;
        const old = document.getElementById('cursor-control-style');
        if (old) old.remove();
        document.head.appendChild(style);
    }

    /* ============ GLOBAL HOTKEY ROUTER ============ */
    window.electronAPI.onGlobalHotkey((data) => {
        const key = data.hotkey;
        const step = 20;
        console.log(`🌍 Hotkey: ${key}`);

        switch (key) {
            case 'answer': if (btnAnswer && !btnAnswer.disabled) handleAnswerButton(); break;
            case 'clear': if (btnClear) handleClearButton(); break;
            case 'chat': toolbarChat?.click(); break;
            case 'mic': toggleMic(); break;
            case 'system': toggleSystem(); break;
            case 'move-left': moveOverlay(-step, 0); break;
            case 'move-right': moveOverlay(step, 0); break;
            case 'move-up': moveOverlay(0, -step); break;
            case 'move-down': moveOverlay(0, step); break;
            case 'answer-scroll-up':
                scrollAnswerArea(-(qaAnswer?.clientHeight * 0.5 || 200));
                break;
            case 'answer-scroll-down':
                scrollAnswerArea(qaAnswer?.clientHeight * 0.5 || 200);
                break;
            case 'page-down': scrollAnswerArea(qaAnswer?.clientHeight * 0.8 || 400); break;
            case 'page-up': scrollAnswerArea(-(qaAnswer?.clientHeight * 0.8 || 400)); break;
            case 'screenshot': openChatWithScreenshot(); break;
            case 'prev-q': navigatePrevQ(); break;
            case 'next-q': navigateNextQ(); break;

            case 'copy-code':
                copyLatestCodeBlock();
                break;
            case 'copy-code-prev':
                copyCodeBlockByOffset(-1);
                break;
            case 'copy-code-next':
                copyCodeBlockByOffset(+1);
                break;
        }
    });

    function scrollAnswerArea(delta) {
        if (qaAnswer) {
            qaAnswer.scrollTop += delta;
            isAutoScrollEnabled = false;
        }
    }

    /* ============ OVERLAY MOVEMENT ============ */
    let posX = 0, posY = 0;
    function moveOverlay(dx, dy) {
        posX += dx; posY += dy;
        [aiToolbar, aiPanel].forEach(el => {
            if (el) el.style.transform = `translate(calc(-50% + ${posX}px), ${posY}px)`;
        });
        console.log(`📍 Overlay: (${posX}, ${posY})`);
    }

    /* ============ AUDIO STATUS ============ */
    function updateAudioStatus() {
        if (btnMic) {
            btnMic.classList.toggle("is-on", !micMuted);
            btnMic.classList.toggle("is-off", micMuted);
            btnMic.removeAttribute('title');
            btnMic.setAttribute('aria-label', micMuted ? 'Mic muted' : 'Mic active');
        }
        if (btnSystem) {
            btnSystem.classList.toggle("is-on", !systemMuted);
            btnSystem.classList.toggle("is-off", systemMuted);
            btnSystem.removeAttribute('title');
            btnSystem.setAttribute('aria-label', systemMuted ? 'System audio muted' : 'System audio active');
        }
        updateToolbarDuration();
    }

    /* ============ CLICK-THROUGH ============ */
    function setupClickThroughOverlay() {
        console.log("🔥 Click-through setup");
        if (!window.electronAPI?.toggleClickThrough) return;

        let currentInteractive = false;
        let lastCheck = 0;
        const THROTTLE = 50;

        window.electronAPI.toggleClickThrough(false);

        document.addEventListener('mousemove', (e) => {
            if (!document.body.classList.contains('step4-active')) {
                if (currentInteractive !== true) {
                    currentInteractive = true;
                    window.electronAPI.toggleClickThrough(false);
                }
                return;
            }

            const now = Date.now();
            if (now - lastCheck < THROTTLE) return;
            lastCheck = now;

            const el = document.elementFromPoint(e.clientX, e.clientY);
            const interactive = checkIfInteractive(el);

            if (interactive !== currentInteractive) {
                currentInteractive = interactive;
                window.electronAPI.toggleClickThrough(!interactive);
                console.log(interactive ? '✅ INTERACTIVE' : '🔴 PASS-THROUGH');
            }
        });

        document.addEventListener('mouseleave', () => {
            if (!document.body.classList.contains('step4-active')) return;
            currentInteractive = false;
            window.electronAPI.toggleClickThrough(true);
        });
    }

    function checkIfInteractive(el) {
        if (!el) return false;
        const selectors = [
            'button', 'input', 'textarea', 'select', 'a',
            '.primary-btn', '.secondary-btn', '.tab', '.ctrl',
            '.circle-icon', '.square-icon', '.qa-card', '.chat-bar',
            '.control-row', '.ai-panel-header', 'label',
            '.chatgpt-code-block', '.copy-button',
            '[role="button"]', '[contenteditable]'
        ];
        let cur = el;
        while (cur && cur !== document.body) {
            if (selectors.includes(cur.tagName.toLowerCase())) return true;
            for (const s of selectors) {
                if (s.startsWith('.') && cur.classList?.contains(s.slice(1))) return true;
            }
            if (cur.getAttribute?.('role') === 'button') return true;
            cur = cur.parentElement;
        }
        return false;
    }

    /* ============ FLOATING CHAT BAR CONTROL ============ */
    function openChatBar() {
        if (!chatBar) return;
        chatBar.style.display = "flex";
        toolbarChat?.classList.add("active");
        setTimeout(() => chatInput?.focus(), 80);
        console.log('💬 Chat bar opened');
    }

    function closeChatBar() {
        if (!chatBar) return;
        chatBar.style.display = "none";
        toolbarChat?.classList.remove("active");
        clearChatAttachment();
        console.log('💬 Chat bar closed');
    }

    /* ============ SCREENSHOT → CHAT ATTACHMENT ============ */
    function openChatWithScreenshot() {
        console.log('📸 openChatWithScreenshot() called');
        if (isCapturingForChat) {
            console.log('⏳ Already capturing — ignoring');
            return;
        }
        if (!isSessionActive) {
            showInAppAlert("Start a session first");
            return;
        }
        isCapturingForChat = true;

        openChatBar();

        if (chatAttachmentPreview) {
            chatAttachmentPreview.style.display = "flex";
            chatAttachmentPreview.innerHTML =
                '<span style="color:#93c5fd;font-size:12px;">📸 Capturing screenshot…</span>';
        }

        try {
            window.electronAPI.captureForChat();
            console.log('📸 captureForChat() sent to main');
        } catch (err) {
            console.error('❌ captureForChat failed:', err);
            isCapturingForChat = false;
            toolbarScreenshot?.classList.remove('capturing');
        }
    }

    function rebuildAttachmentPreview() {
        if (!chatAttachmentPreview) return;
        chatAttachmentPreview.innerHTML = `
            <img id="chatAttachmentThumb" class="chat-attachment-thumb" alt="Screenshot" />
            <button id="chatAttachmentRemove" class="chat-attachment-remove"
                    aria-label="Remove attachment" title="">✕</button>
            <span class="chat-attachment-label">Screenshot attached</span>
        `;
        document.getElementById("chatAttachmentRemove")
            ?.addEventListener("click", (e) => {
                e.preventDefault();
                e.stopPropagation();
                clearChatAttachment();
            });
    }

    function clearChatAttachment() {
        pendingChatImage = null;
        if (chatAttachmentPreview) {
            chatAttachmentPreview.style.display = "none";
            chatAttachmentPreview.innerHTML = "";
        }
    }

    /* ============ Q&A HISTORY NAVIGATION ============ */
    function pushToQaHistory(question, rawText, bulletMode) {
        if (!question) return;

        if (qaHistoryIndex >= 0 && qaHistoryIndex < qaHistory.length - 1) {
            qaHistory = qaHistory.slice(0, qaHistoryIndex + 1);
        }

        const raw = rawText || '';
        const bm = !!bulletMode;

        qaHistory.push({
            question,
            raw,
            bulletMode: bm,
            html: formatAnswerHtml(raw, { bulletMode: bm }),
            timestamp: Date.now()
        });

        if (qaHistory.length > 100) qaHistory.shift();

        qaHistoryIndex = qaHistory.length - 1;
        updateQaNavUI();
        console.log(`📚 Q&A history: ${qaHistory.length} entries, showing #${qaHistoryIndex + 1}`);
    }

    function showQaAt(index) {
        if (index < 0 || index >= qaHistory.length) return;
        qaHistoryIndex = index;
        const entry = qaHistory[index];

        if (qaQuestion) {
            qaQuestion.textContent = entry.question;
            qaQuestion.classList.remove('partial-text');
        }
        if (qaAnswer) {
            const html = entry.html || formatAnswerHtml(entry.raw || '', {
                bulletMode: !!entry.bulletMode
            });
            qaAnswer.innerHTML = html;
            wireCodeBlockCopyButtons(qaAnswer);
            qaAnswer.scrollTop = 0;
        }
        updateQaNavUI();
        console.log(`📖 Showing Q&A #${index + 1} / ${qaHistory.length}`);
    }

    function navigatePrevQ() {
        if (qaHistory.length === 0) return;
        if (qaHistoryIndex <= 0) {
            console.log('⏮️ Already at first Q&A');
            return;
        }
        showQaAt(qaHistoryIndex - 1);
    }

    function navigateNextQ() {
        if (qaHistory.length === 0) return;
        if (qaHistoryIndex >= qaHistory.length - 1) {
            console.log('⏭️ Already at latest Q&A');
            return;
        }
        showQaAt(qaHistoryIndex + 1);
    }

    function updateQaNavUI() {
        const total = qaHistory.length;
        const current = qaHistoryIndex >= 0 ? qaHistoryIndex + 1 : 0;

        if (qaCounter) qaCounter.textContent = `${current} / ${total}`;
        if (btnPrevQ) btnPrevQ.disabled = (qaHistoryIndex <= 0);
        if (btnNextQ) btnNextQ.disabled = (qaHistoryIndex < 0 || qaHistoryIndex >= total - 1);
    }

    function resetQaHistory() {
        qaHistory = [];
        qaHistoryIndex = -1;
        _lastCopiedCodeIdx = -1;
        updateQaNavUI();
        console.log('🗑️ Q&A history cleared');
    }

    /* ============ SCREENSHOT IPC (legacy silent analyze flow) ============ */
    window.electronAPI.onScreenshotTranscript((data) => {
        console.log('📝 Screenshot transcript:', data.text);
        currentTranscript = data.text;
        qaQuestion.textContent = data.text;
        qaQuestion.classList.remove('partial-text');
    });

    window.electronAPI.onScreenshotProcessing((data) => {
        qaAnswer.innerHTML = `
            <div class="screenshot-processing" style="
                background: rgba(15,23,42,0.95); border-radius:12px;
                padding:16px 20px; border:1px solid #3b82f6;
                margin:8px 0; display:flex; align-items:center; gap:12px;">
                <span style="font-size:24px;">📸</span>
                <div style="color:#93c5fd;">${data.message || 'Processing...'}</div>
            </div>`;
    });

    window.electronAPI.onScreenshotResult((data) => {
        console.log('📸 Screenshot result');
        if (qaAnswer && data.success) {
            qaAnswer.innerHTML = `
                <div class="screenshot-result" style="
                    background: rgba(15,23,42,0.95); border-radius:12px;
                    padding:16px 20px; border:1px solid #10b981;
                    margin:8px 0;">
                    <div style="color:#93c5fd;font-weight:500;margin-bottom:12px;">
                        📸 Screenshot Analysis
                    </div>
                    <div style="color:#e2e8f0;line-height:1.8;font-size:14px;">
                        ${escapeHtml(data.analysis || '')}
                    </div>
                </div>`;
        }
    });

    window.electronAPI.onScreenshotError((data) => {
        if (qaAnswer) {
            qaAnswer.innerHTML = `
                <div style="background:rgba(239,68,68,0.1);border:1px solid #ef4444;
                            border-radius:12px;padding:16px;margin:8px 0;color:#f87171;">
                    ❌ ${data.message || 'Screenshot failed'}
                </div>`;
        }
    });

    /* ============ CHAT BOX ============ */
    function setupChatBox() {
        if (!toolbarChat || !chatInput) return;

        toolbarChat.addEventListener("click", (e) => {
            e.stopPropagation();
            const vis = chatBar && chatBar.style.display === "flex";
            if (vis) {
                closeChatBar();
            } else {
                openChatBar();
            }
        });

        chatInput.addEventListener("keypress", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendChatQuestion();
            }
        });

        btnSendChat?.addEventListener("click", sendChatQuestion);

        chatBarClose?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            closeChatBar();
        });
    }

    async function sendChatQuestion() {
        const typed = (chatInput?.value || "").trim();
        const hasImage = !!pendingChatImage;

        if (!typed && !hasImage) return;
        if (!isSessionActive) { showInAppAlert("Start a session first"); return; }

        const questionText = typed || "";
        const imageToSend = pendingChatImage;

        currentBulletMode = detectBulletMode(questionText);

        if (chatInput) chatInput.value = "";
        clearChatAttachment();
        closeChatBar();

        const displayQuestion = questionText
            || (hasImage ? "(screenshot — using live interviewer speech)" : "");
        if (qaQuestion) qaQuestion.textContent = displayQuestion;

        if (hasImage && qaAnswer) {
            qaAnswer.innerHTML = `
                <div class="screenshot-result" style="
                    background: rgba(15,23,42,0.95); border-radius:12px;
                    padding:10px 14px; border:1px solid #3b82f6;
                    margin:8px 0; display:flex; align-items:center; gap:10px;">
                    <img src="data:image/jpeg;base64,${imageToSend}"
                         style="max-height:44px;max-width:80px;border-radius:6px;
                                border:1px solid rgba(148,163,184,0.5);" />
                    <span style="font-size:12px;color:#93c5fd;">Screenshot attached · analyzing…</span>
                </div>
                <div class="thinking">Generating answer…</div>`;
        } else if (qaAnswer) {
            qaAnswer.innerHTML = '<div class="thinking">Generating answer…</div>';
        }

        try {
            const endpoint = hasImage
                ? "http://127.0.0.1:8000/api/chat-question-image"
                : "http://127.0.0.1:8000/api/answer-stream-fast";

            const payload = hasImage
                ? { text: questionText, image: imageToSend }
                : { text: questionText };

            const t0 = performance.now();
            const r = await fetch(endpoint, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            const reader = r.body.getReader();
            const decoder = new TextDecoder();
            let buf = "", acc = "";
            let firstTokenLogged = false;

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const lines = buf.split("\n\n");
                buf = lines.pop() || "";
                for (const line of lines) {
                    if (!line.startsWith("data: ")) continue;
                    try {
                        const d = JSON.parse(line.slice(6));
                        if (d.type === "ai_stream") {
                            if (!firstTokenLogged) {
                                console.log(`⚡ First token in ${(performance.now()-t0).toFixed(0)}ms`);
                                firstTokenLogged = true;
                            }
                            acc += d.content || "";
                            if (qaAnswer.querySelector('.screenshot-result, .thinking')
                                && acc.length > 0
                                && !qaAnswer.querySelector('.paragraph, .bullet-item, .chatgpt-code-block')) {
                                qaAnswer.innerHTML = '';
                            }
                            renderStreamingAnswer(qaAnswer, acc);
                        } else if (d.type === "ai_complete") {
                            // Always re-render from raw so stream HTML == final HTML.
                            renderAnswer(qaAnswer, acc, { bulletMode: currentBulletMode });
                            console.log(`✅ Complete in ${(performance.now()-t0).toFixed(0)}ms`);
                            pushToQaHistory(displayQuestion, acc, currentBulletMode);
                            setTimeout(() => {
                                qaQuestion.textContent = "Listening for next question...";
                            }, 500);
                        } else if (d.type === "ai_error") {
                            qaAnswer.innerHTML = `<div class="error">Error: ${escapeHtml(d.error || 'unknown')}</div>`;
                        }
                    } catch (_) {}
                }
            }
        } catch (e) {
            console.error("sendChatQuestion failed:", e);
            if (qaAnswer) qaAnswer.innerHTML = `<div class="error">Error: ${escapeHtml(e.message)}</div>`;
        }
    }

    /* ============ INTERNAL DRAG ============ */
    function setupInternalDrag() {
        const panels = document.querySelectorAll('.step-1 .step-light, .step-2 .step-light, .step-3 .step-light');
        panels.forEach(panel => {
            let isDown = false, startX = 0, startY = 0, startScrollLeft = 0, startScrollTop = 0;
            panel.style.overflow = 'auto';
            panel.style.cursor = 'grab';

            panel.addEventListener('mousedown', (e) => {
                if (e.target.closest('input, textarea, button, select, .tab')) return;
                isDown = true;
                panel.style.cursor = 'grabbing';
                startX = e.pageX - panel.offsetLeft;
                startY = e.pageY - panel.offsetTop;
                startScrollLeft = panel.scrollLeft;
                startScrollTop = panel.scrollTop;
            });

            panel.addEventListener('mouseleave', () => { isDown = false; panel.style.cursor = 'grab'; });
            panel.addEventListener('mouseup',   () => { isDown = false; panel.style.cursor = 'grab'; });

            panel.addEventListener('mousemove', (e) => {
                if (!isDown) return;
                e.preventDefault();
                const x = e.pageX - panel.offsetLeft;
                const y = e.pageY - panel.offsetTop;
                panel.scrollLeft = startScrollLeft - (x - startX);
                panel.scrollTop  = startScrollTop  - (y - startY);
            });
        });
    }

    /* ============ MIC / SYSTEM ============ */
    async function toggleMic() {
        try {
            const r = await fetch("http://127.0.0.1:8000/toggle-mic", { method: "POST" });
            const d = await r.json();
            micMuted = d.muted;
            updateAudioStatus();
            if (!micMuted) {
                currentTranscript = "";
                qaQuestion.textContent = "Listening...";
            }
        } catch (e) { updateAudioStatus(); }
    }

    async function toggleSystem() {
        try {
            const r = await fetch("http://127.0.0.1:8000/toggle-system", { method: "POST" });
            const d = await r.json();
            systemMuted = d.muted;
            updateAudioStatus();
            if (!systemMuted) {
                currentTranscript = "";
                qaQuestion.textContent = "Listening...";
            }
        } catch (e) { updateAudioStatus(); }
    }

    /* ============ ANSWER ============ */
       async function handleAnswerButton() {
        if (!isSessionActive || !currentSessionId) {
            showInAppAlert("Start or reopen a session first");
            return;
        }
        if (!currentTranscript.trim()) {
            showInAppAlert("Please speak or type a question first");
            return;
        }
        if (isAiResponding) return;

        const q = currentTranscript.trim();
        isAiResponding = true;
        if (btnAnswer) btnAnswer.disabled = true;

        currentBulletMode = detectBulletMode(q);

        currentTranscript = "";
        qaQuestion.textContent = "AI is answering...";
        qaAnswer.innerHTML = '<div class="thinking">Preparing answer...</div>';

        try {
            const r = await fetch("http://127.0.0.1:8000/api/answer-stream-fast", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    text: q,
                    session_id: currentSessionId,
                    request_id: (crypto.randomUUID
                        ? crypto.randomUUID()
                        : String(Date.now()) + Math.random())
                })
            });

            if (!r.ok || !r.body) {
                throw new Error(`Answer request failed: HTTP ${r.status}`);
            }

            const reader = r.body.getReader();
            const decoder = new TextDecoder();
            let buf = "", acc = "";
            let firstTokenLogged = false;
            const t0 = performance.now();

            const handleLine = (line) => {
                if (!line.startsWith('data: ')) return;
                try {
                    const d = JSON.parse(line.slice(6));
                    if (d.type === 'ai_stream') {
                        if (!firstTokenLogged) {
                            console.log(`⚡ First token in ${(performance.now()-t0).toFixed(0)}ms`);
                            firstTokenLogged = true;
                        }
                        acc += d.content || "";
                        if (acc.length > 0 && !qaAnswer.querySelector('.paragraph, .bullet-item, .chatgpt-code-block')) {
                            qaAnswer.innerHTML = '';
                        }
                        renderStreamingAnswer(qaAnswer, acc);
                    } else if (d.type === 'ai_complete') {
                        renderAnswer(qaAnswer, acc, { bulletMode: currentBulletMode });
                        console.log(`✅ Complete in ${(performance.now()-t0).toFixed(0)}ms`);
                        pushToQaHistory(q, acc, currentBulletMode);
                        setTimeout(() => {
                            qaQuestion.textContent = "Listening for next question...";
                        }, 500);
                    } else if (d.type === 'ai_error') {
                        qaAnswer.innerHTML = `<div class="error">Error: ${escapeHtml(d.error || 'unknown')}</div>`;
                    }
                } catch (_) {}
            };

            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                buf += decoder.decode(value, { stream: true });
                const events = buf.split('\n\n');
                buf = events.pop() || "";
                for (const ev of events) handleLine(ev.trim());
            }

            // Flush any trailing event left in buf when the stream ends.
            buf += decoder.decode();
            const tail = buf.trim();
            if (tail.startsWith('data: ')) handleLine(tail);

        } catch (e) {
            qaAnswer.innerHTML = `<div class="error">Error: ${escapeHtml(e.message)}</div>`;
        } finally {
            isAiResponding = false;
            if (btnAnswer) btnAnswer.disabled = false;
        }
    }

    /* ============ CLEAR ============ */
    async function handleClearButton() {
        currentTranscript = "";
        lastProcessedText = "";
        lastPartialText = "";
        lastFinalText = "";
        duplicateBlockList.clear();
        liveInterviewerText = "";
        liveInterviewerTimestamp = 0;
        _lastCopiedCodeIdx = -1;
        qaQuestion.textContent = "Listening for new question...";
        qaQuestion.classList.remove("partial-text");
        closeChatBar();
        try { await fetch("http://127.0.0.1:8000/api/clear-and-reset", { method: "POST" }); } catch (_) {}
    }

    function showInAppAlert(msg) {
        qaAnswer.innerHTML = `<div class="alert-message"><strong>⚠️ ${msg}</strong></div>`;
        setTimeout(() => { if (qaAnswer.innerHTML.includes(msg)) qaAnswer.innerHTML = ""; }, 3000);
    }

    /* ============ SESSION ============ */
    async function createSession() {
        const company = companyInput.value.trim();
        const jd = jobDescInput.value.trim();
        const resume = resumeText.value.trim();
        const ctx = contextInput.value.trim();

        if (!company || !jd || !resume) {
            showInAppAlert("Please fill in all required fields");
            return;
        }

        try {
            const r = await fetch("http://127.0.0.1:8000/api/session/create", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    company, job_description: jd, resume_text: resume, extra_context: ctx
                })
            });
            const d = await r.json();
            if (d.success) {
                currentSessionId = d.session_id;
                isSessionActive = true;

                document.body.classList.add("step4-active");
                aiPanel.dataset.open = "true";

                window.electronAPI.toggleClickThrough(true);

                micMuted = false;
                updateAudioStatus();
                connectSSE();
                startSessionTimer();
                resetQaHistory();

                qaQuestion.textContent = "Session started!";
                qaAnswer.innerHTML = "";

                setTimeout(() => {
                    fetch("http://127.0.0.1:8000/api/clear-and-reset", { method: "POST" });
                }, 500);
            }
        } catch (e) {
            showInAppAlert("Session failed: " + e.message);
        }
    }

    function stopSession() {
        isSessionActive = false;
        document.body.classList.remove("step4-active");
        aiPanel.dataset.open = "false";

        window.electronAPI.toggleClickThrough(false);

        if (sseConnection) { sseConnection.close(); sseConnection = null; }
        stopSessionTimer();
        currentTranscript = "";
        currentSessionId = null;
        liveInterviewerText = "";
        liveInterviewerTimestamp = 0;
        _lastCopiedCodeIdx = -1;

        closeChatBar();
        resetQaHistory();

        if (qaQuestion) qaQuestion.textContent = "Session ended";
        if (qaAnswer) qaAnswer.innerHTML = "";
    }

    function startSessionTimer() {
        if (sessionTimer) clearInterval(sessionTimer);
        sessionStartTime = Date.now();
        sessionTimer = setInterval(updateToolbarDuration, 1000);
    }
    function stopSessionTimer() {
        if (sessionTimer) { clearInterval(sessionTimer); sessionTimer = null; }
    }
    function updateToolbarDuration() {
        if (!sessionStartTime) return;
        const el = Date.now() - sessionStartTime;
        const m = Math.floor(el / 60000);
        const s = Math.floor((el % 60000) / 1000);
        if (toolbarDuration) {
            toolbarDuration.textContent = `⏱️ ${m.toString().padStart(2,'0')}:${s.toString().padStart(2,'0')}`;
        }
    }

    /* ============ SSE ============ */
    function connectSSE() {
        if (sseConnection) { sseConnection.close(); sseConnection = null; }
        try {
            sseConnection = new EventSource("http://127.0.0.1:8000/stream");
            sseConnection.onopen = () => { reconnectAttempts = 0; };
            sseConnection.onmessage = (ev) => {
                try {
                    const d = JSON.parse(ev.data);
                    if (d.type === "ai_status") {
                        if (d.is_responding) qaQuestion.textContent = "AI is answering...";
                        return;
                    }
                    if (d.type === "transcript") {
                        if (d.ai_responding) {
                            if (d.text) qaQuestion.textContent = d.text;
                        } else handleTranscript(d);
                    }
                } catch (_) {}
            };
            sseConnection.onerror = () => {
                sseConnection?.close();
                sseConnection = null;
                reconnectAttempts++;
                if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                    setTimeout(connectSSE, 1000);
                }
            };
        } catch (_) { setTimeout(connectSSE, 1000); }
    }

       function handleTranscript(data) {
        const text = data.text?.trim();
        if (!text) return;

        if (data.source === "mic" && micMuted) return;
        if (data.source === "system" && systemMuted) return;

        const now = Date.now();

        if (data.source === "system") {
            liveInterviewerText = text;
            liveInterviewerTimestamp = now;
        }

        // Partial speech: preview only — never submit it as the question.
        if (data.is_partial || data.is_final === false) {
            lastPartialText = text;
            qaQuestion.textContent = text;
            qaQuestion.classList.add("partial-text");
            return;
        }

        if (!data.is_final) return;

        // Dedup final transcripts within a very short window.
        if (text === lastProcessedText && (now - lastProcessedTime) < 300) return;
        lastProcessedText = text;
        lastProcessedTime = now;

        lastPartialText = "";
        currentTranscript = text;
        qaQuestion.textContent = currentTranscript;
        qaQuestion.classList.remove("partial-text");
    }

    /* ============ STEPS / TABS ============ */
    function setupSteps() {
        const steps = document.querySelectorAll(".step");
        function showStep(n) {
            steps.forEach(s => s.classList.remove("active"));
            document.querySelector(`.step-${n}`)?.classList.add("active");
        }
        document.getElementById("btnFreeSession")?.addEventListener("click", () => showStep(2));
        document.getElementById("btnBack2")?.addEventListener("click", () => showStep(1));
        document.getElementById("btnNext2")?.addEventListener("click", () => showStep(3));
        document.getElementById("btnBack3")?.addEventListener("click", () => showStep(2));
        document.getElementById("btnCreate")?.addEventListener("click", createSession);
    }

    function setupTabs() {
        tabs.forEach(tab => {
            tab.addEventListener("click", () => {
                tabs.forEach(t => t.classList.remove("active"));
                tabPanels.forEach(p => p.classList.remove("active"));
                tab.classList.add("active");
                const id = tab.getAttribute("data-tab");
                document.querySelector(`[data-panel="${id}"]`)?.classList.add("active");
                if (id === "history") loadSessions();
            });
        });
    }

    /* ============ SESSIONS LIST (Past Sessions) ============ */
    let selectedSessionId = null;

    async function loadSessions() {
        try {
            const r = await fetch("http://127.0.0.1:8000/api/session/list");
            const d = await r.json();
            if (!sessionList) return;

            if (d.success && d.sessions?.length) {
                sessionList.innerHTML = d.sessions.map(s => {
                    const company = escapeHtml(s.company || 'Unnamed');
                    const when = s.created_at ? new Date(s.created_at).toLocaleString() : '';
                    const count = s.message_count != null ? s.message_count : 0;
                    return `
                        <div class="session-item" data-session-id="${s.id}">
                            <div class="session-company">${company}</div>
                            <div class="session-meta-row">
                                <span>${escapeHtml(when)}</span>
                                <span class="session-count">${count} msgs</span>
                            </div>
                        </div>`;
                }).join('');

                sessionList.querySelectorAll('.session-item').forEach(el => {
                    el.addEventListener('click', () => {
                        const id = parseInt(el.dataset.sessionId, 10);
                        if (!isNaN(id)) viewSessionDetail(id);
                    });
                });

                const first = sessionList.querySelector('.session-item');
                if (first) viewSessionDetail(parseInt(first.dataset.sessionId, 10));
            } else {
                sessionList.innerHTML = '<div class="session-empty">No past sessions yet.</div>';
                showSessionDetailEmpty();
            }
        } catch (e) {
            console.error('loadSessions failed:', e);
            if (sessionList) sessionList.innerHTML = '<div class="session-empty">Failed to load.</div>';
        }
    }

    function showSessionDetailEmpty() {
        const empty = document.getElementById('sessionDetailEmpty');
        const body = document.getElementById('sessionDetailBody');
        if (empty) empty.style.display = 'block';
        if (body) body.style.display = 'none';
    }

    function showSessionDetailBody() {
        const empty = document.getElementById('sessionDetailEmpty');
        const body = document.getElementById('sessionDetailBody');
        if (empty) empty.style.display = 'none';
        if (body) body.style.display = 'block';
    }

    async function viewSessionDetail(sessionId) {
        try {
            selectedSessionId = sessionId;

            sessionList?.querySelectorAll('.session-item').forEach(el => {
                el.classList.toggle('active', parseInt(el.dataset.sessionId, 10) === sessionId);
            });

            const r = await fetch(`http://127.0.0.1:8000/api/session/${sessionId}/history`);
            const d = await r.json();
            if (!d.success) throw new Error(d.error || 'Failed to load history');

            const s = d.session || {};
            const history = d.history || [];

            const meta = document.getElementById('sessionMeta');
            if (meta) {
                const created = s.created_at ? new Date(s.created_at).toLocaleString() : '—';
                meta.innerHTML = `
                    <div><strong>Company:</strong> ${escapeHtml(s.company || 'Unnamed')}</div>
                    <div><strong>Created:</strong> ${escapeHtml(created)}</div>
                    <div><strong>Messages:</strong> ${history.length}</div>
                `;
            }

            const msgs = document.getElementById('sessionMessages');
            if (msgs) {
                if (!history.length) {
                    msgs.innerHTML = '<div class="session-detail-empty">No messages in this session.</div>';
                } else {
                    msgs.innerHTML = history.map(m => {
                        const isQ = m.role === 'question';
                        const cls = isQ ? 'msg-question' : 'msg-answer';
                        const roleLabel = isQ ? 'Question' : 'Answer';
                        const t = m.created_at ? new Date(m.created_at).toLocaleTimeString() : '';
                        return `
                            <div class="msg-row ${cls}">
                                <span class="msg-role">${roleLabel}</span>
                                <div class="msg-content">${escapeHtml(m.content || '')}</div>
                                ${t ? `<span class="msg-time">${escapeHtml(t)}</span>` : ''}
                            </div>`;
                    }).join('');
                }
            }

            showSessionDetailBody();
        } catch (e) {
            console.error('viewSessionDetail failed:', e);
            showSessionDetailEmpty();
        }
    }

    async function reopenSelectedSession() {
        if (!selectedSessionId) {
            showInAppAlert('Select a session first');
            return;
        }
        try {
            const r = await fetch(`http://127.0.0.1:8000/api/session/${selectedSessionId}/reopen`, {
                method: 'POST'
            });
            const d = await r.json();
            if (!d.success) throw new Error(d.error || 'Reopen failed');

            currentSessionId = d.session_id;
            isSessionActive = true;

            const s = d.session || {};
            if (companyInput) companyInput.value = s.company || '';
            if (jobDescInput) jobDescInput.value = s.job_description || '';
            if (resumeText) resumeText.value = s.resume_text || '';
            if (contextInput) contextInput.value = s.extra_context || '';

            document.body.classList.add('step4-active');
            if (aiPanel) aiPanel.dataset.open = 'true';
            if (window.electronAPI?.toggleClickThrough) window.electronAPI.toggleClickThrough(true);

            resetQaHistory();

            const history = d.history || [];
            let lastQ = null;
            for (const m of history) {
                if (m.role === 'question') {
                    lastQ = m.content || '';
                } else if (m.role === 'answer' && lastQ != null) {
                    const answerRaw = m.content || '';
                    const bm = detectBulletMode(lastQ);
                    pushToQaHistory(lastQ, answerRaw, bm);
                    lastQ = null;
                }
            }

            if (qaHistory.length > 0) {
                showQaAt(qaHistory.length - 1);
            } else {
                if (qaQuestion) qaQuestion.textContent = 'Session reopened. Listening…';
                if (qaAnswer) qaAnswer.innerHTML = '';
            }

            micMuted = false;
            updateAudioStatus();
            connectSSE();
            startSessionTimer();

            closeChatBar();

            console.log(`🔁 Reopened session ${d.session_id} with ${history.length} messages`);
        } catch (e) {
            console.error('reopenSelectedSession failed:', e);
            showInAppAlert('Reopen failed: ' + e.message);
        }
    }

    async function deleteSelectedSession() {
        if (!selectedSessionId) {
            showInAppAlert('Select a session first');
            return;
        }

        const confirmed = await showInPageConfirm(
            'Delete this session and all its messages? This cannot be undone.'
        );
        if (!confirmed) return;

        const btn = document.getElementById('btnDeleteSession');
        const originalText = btn ? btn.textContent : '';
        if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }

        try {
            const r = await fetch(`http://127.0.0.1:8000/api/session/${selectedSessionId}`, {
                method: 'DELETE'
            });
            const d = await r.json();
            if (!d.success) throw new Error(d.error || 'Delete failed');

            if (currentSessionId === selectedSessionId) {
                stopSession();
            }

            const deletedId = selectedSessionId;
            selectedSessionId = null;
            showSessionDetailEmpty();
            await loadSessions();

            console.log(`🗑️ Deleted session ${deletedId}`);
        } catch (e) {
            console.error('deleteSelectedSession failed:', e);
            showInAppAlert('Delete failed: ' + e.message);
        } finally {
            if (btn) { btn.disabled = false; btn.textContent = originalText || 'Delete'; }
        }
    }

    /* ============ EVENT LISTENERS ============ */
    function setupEventListeners() {
        btnMic?.addEventListener("click", toggleMic);
        btnSystem?.addEventListener("click", toggleSystem);
        btnAnswer?.addEventListener("click", handleAnswerButton);
        btnClear?.addEventListener("click", handleClearButton);
        btnBackToSettings?.addEventListener("click", stopSession);
        btnToolbarCancel?.addEventListener("click", stopSession);
        btnCollapse?.addEventListener("click", () => {
            aiPanel?.classList.toggle("collapsed");
            if (btnCollapse) btnCollapse.textContent = aiPanel.classList.contains("collapsed") ? "˄" : "˅";
        });

        btnPrevQ?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            navigatePrevQ();
        });

        btnNextQ?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            navigateNextQ();
        });

        toolbarScreenshot?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('📸 Screenshot pill clicked');
            openChatWithScreenshot();
        });

        chatAttachmentRemove?.addEventListener("click", (e) => {
            e.preventDefault();
            e.stopPropagation();
            clearChatAttachment();
        });

        document.getElementById('btnMin')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAPI.minimizeWindow();
        });
        document.getElementById('btnClose')?.addEventListener('click', (e) => {
            e.preventDefault();
            window.electronAPI.closeWindow();
        });
    }

    /* ============ INIT ============ */
    function initialize() {
        console.log("🔧 Initializing...");
        setupCursorControl();
        setupClickThroughOverlay();
        setupTabs();
        setupSteps();
        setupEventListeners();
        setupChatBox();

        document.getElementById("btnReopenSession")?.addEventListener("click", reopenSelectedSession);
        document.getElementById("btnDeleteSession")?.addEventListener("click", deleteSelectedSession);

        if (window.electronAPI?.onScreenshotCaptured) {
            window.electronAPI.onScreenshotCaptured((data) => {
                console.log('📸 Screenshot received:', data?.image?.length, 'bytes');
                isCapturingForChat = false;
                toolbarScreenshot?.classList.remove('capturing');

                if (!data || !data.image) {
                    if (chatAttachmentPreview) {
                        chatAttachmentPreview.innerHTML =
                            '<span style="color:#f87171;font-size:12px;">❌ Capture failed</span>';
                        setTimeout(() => clearChatAttachment(), 2000);
                    }
                    return;
                }

                pendingChatImage = data.image;
                rebuildAttachmentPreview();

                const thumb = document.getElementById("chatAttachmentThumb");
                if (thumb) thumb.src = `data:image/jpeg;base64,${data.image}`;

                if (isSessionActive) {
                    console.log('🚀 Auto-sending screenshot (backend uses live interviewer text)');
                    setTimeout(() => sendChatQuestion(), 60);
                }
            });
        } else {
            console.warn('⚠️ onScreenshotCaptured not exposed in preload.js');
        }

        document.querySelectorAll(".step").forEach(s => s.classList.remove("active"));
        document.querySelector(".step-1")?.classList.add("active");

        updateAudioStatus();
        updateQaNavUI();

        const modelSelect = document.getElementById("modelSelect");
        if (modelSelect) {
            modelSelect.innerHTML = `
                <option value="gpt-4o-mini" selected>GPT-4o Mini</option>
                <option value="gpt-4o">GPT-4o</option>
                <option value="gpt-4-turbo">GPT-4 Turbo</option>
            `;
        }

        console.log("✅ Ready");
    }

    initialize();

    // SSE watchdog
    setInterval(() => {
        if (isSessionActive && (!sseConnection || sseConnection.readyState === EventSource.CLOSED)) {
            connectSSE();
        }
    }, 5000);
});

/* ============ HELPERS (outside DOMContentLoaded) ============ */
function escapeHtml(text) {
    const d = document.createElement('div');
    d.textContent = text == null ? '' : String(text);
    return d.innerHTML;
}

/* ============ COPY-TO-CLIPBOARD (bulletproof for Electron) ============ */
async function copyToClipboard(text, buttonEl) {
    if (!text) return false;
    let ok = false;

    try {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'fixed';
        ta.style.top = '0';
        ta.style.left = '0';
        ta.style.opacity = '0';
        ta.style.pointerEvents = 'none';
        document.body.appendChild(ta);
        ta.focus();
        ta.select();
        ta.setSelectionRange(0, ta.value.length);
        ok = document.execCommand('copy');
        ta.remove();
    } catch (e) {
        console.warn('execCommand copy failed:', e);
        ok = false;
    }

    if (!ok && navigator.clipboard?.writeText) {
        try {
            await navigator.clipboard.writeText(text);
            ok = true;
        } catch (e) {
            console.warn('navigator.clipboard failed:', e);
            ok = false;
        }
    }

    if (!ok && window.electronAPI?.copyToClipboard) {
        try {
            await window.electronAPI.copyToClipboard(text);
            ok = true;
        } catch (e) {
            console.warn('electronAPI.copyToClipboard failed:', e);
            ok = false;
        }
    }

    if (buttonEl) {
        const original = buttonEl.textContent;
        if (ok) {
            buttonEl.classList.add('copied');
            buttonEl.textContent = '✓ Copied';
        } else {
            buttonEl.classList.add('copy-failed');
            buttonEl.textContent = '✗ Failed';
        }
        setTimeout(() => {
            buttonEl.classList.remove('copied', 'copy-failed');
            buttonEl.textContent = original || 'Copy code';
        }, 1200);
    }

    return ok;
}

/* ============ WIRE CODE BLOCK COPY BUTTONS ============ */
function wireCodeBlockCopyButtons(container) {
    if (!container) return;
    container.querySelectorAll('.chatgpt-code-block .copy-button:not([data-wired])')
        .forEach(btn => {
            btn.dataset.wired = '1';
            btn.addEventListener('click', (e) => {
                e.preventDefault();
                e.stopPropagation();
                const block = btn.closest('.chatgpt-code-block');
                const codeEl = block?.querySelector('pre code');
                if (codeEl) copyToClipboard(codeEl.textContent, btn);
            });
        });
}

/* ============ GLOBAL HOTKEY: COPY CODE BLOCK ============ */
let _lastCopiedCodeIdxGlobal = -1;

function copyLatestCodeBlock() {
    const answer = document.getElementById('qaAnswer');
    if (!answer) return;

    const blocks = Array.from(answer.querySelectorAll('.chatgpt-code-block'));
    if (blocks.length === 0) {
        showCopyToast('No code block found');
        return;
    }

    const hovered = document.querySelector('.chatgpt-code-block:hover');
    const target = hovered || blocks[blocks.length - 1];

    _lastCopiedCodeIdxGlobal = blocks.indexOf(target);

    const codeEl = target.querySelector('pre code');
    if (!codeEl) {
        showCopyToast('Code block is empty');
        return;
    }

    const copyBtn = target.querySelector('.copy-button');
    copyToClipboard(codeEl.textContent, copyBtn);
    showCopyToast('✅ Code copied to clipboard');

    target.classList.add('copied-flash');
    setTimeout(() => target.classList.remove('copied-flash'), 600);
}

function copyCodeBlockByOffset(offset) {
    const answer = document.getElementById('qaAnswer');
    if (!answer) return;

    const blocks = Array.from(answer.querySelectorAll('.chatgpt-code-block'));
    if (blocks.length === 0) {
        showCopyToast('No code block found');
        return;
    }

    let idx = _lastCopiedCodeIdxGlobal;
    if (idx < 0) idx = blocks.length - 1;
    idx = (idx + offset + blocks.length) % blocks.length;
    _lastCopiedCodeIdxGlobal = idx;

    const target = blocks[idx];
    const codeEl = target.querySelector('pre code');
    if (!codeEl) return;

    const copyBtn = target.querySelector('.copy-button');
    copyToClipboard(codeEl.textContent, copyBtn);
    showCopyToast(`✅ Code block ${idx + 1}/${blocks.length} copied`);

    target.classList.add('copied-flash');
    setTimeout(() => target.classList.remove('copied-flash'), 600);

    target.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function showCopyToast(message) {
    let toast = document.getElementById('copyToast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'copyToast';
        toast.className = 'copy-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = message;
    toast.classList.add('show');
    clearTimeout(showCopyToast._t);
    showCopyToast._t = setTimeout(() => toast.classList.remove('show'), 1600);
}

/* ============ IN-PAGE CONFIRM (Electron-safe) ============ */
function showInPageConfirm(message) {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.id = 'inPageConfirmOverlay';
        overlay.style.cssText = `
            position: fixed; inset: 0;
            background: rgba(0,0,0,0.55);
            display: flex; align-items: center; justify-content: center;
            z-index: 99999;
            -webkit-app-region: no-drag;
        `;

        const box = document.createElement('div');
        box.style.cssText = `
            background: #0f172a;
            border: 1px solid #334155;
            border-radius: 14px;
            padding: 20px 22px;
            min-width: 320px;
            max-width: 90vw;
            box-shadow: 0 20px 60px rgba(0,0,0,0.8);
            color: #f9fafb;
            font-family: inherit;
        `;

        const msg = document.createElement('div');
        msg.textContent = message;
        msg.style.cssText = 'font-size:14px; line-height:1.5; margin-bottom:18px;';

        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex; gap:10px; justify-content:flex-end;';

        const btnCancel = document.createElement('button');
        btnCancel.textContent = 'Cancel';
        btnCancel.style.cssText = `
            background:#1e293b; color:#e5e7eb;
            border:1px solid #475569; border-radius:8px;
            padding:7px 16px; font-size:13px; cursor:pointer;
        `;

        const btnConfirm = document.createElement('button');
        btnConfirm.textContent = 'Delete';
        btnConfirm.style.cssText = `
            background:#ef4444; color:#fff;
            border:1px solid #ef4444; border-radius:8px;
            padding:7px 16px; font-size:13px; cursor:pointer;
            font-weight:600;
        `;

        function cleanup(result) {
            overlay.remove();
            resolve(result);
        }

        btnCancel.addEventListener('click', () => cleanup(false));
        btnConfirm.addEventListener('click', () => cleanup(true));

        const onKey = (e) => {
            if (e.key === 'Escape') {
                document.removeEventListener('keydown', onKey);
                cleanup(false);
            }
        };
        document.addEventListener('keydown', onKey);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) cleanup(false);
        });

        btnRow.appendChild(btnCancel);
        btnRow.appendChild(btnConfirm);
        box.appendChild(msg);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        btnConfirm.focus();
    });
}