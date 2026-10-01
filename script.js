const DB_KEY = 'local_workspace_data';
const COMMANDS = [
    { id: 'image', label: 'Image', desc: '画像を挿入', keys: ['image', '画像', 'pic'] },
    { id: 'link', label: 'Web Link', desc: 'Webリンクを挿入', keys: ['link', 'リンク'] },
    { id: 'table', label: 'Table', desc: '表を追加', keys: ['table', '表', 'ひょう'] }, // ★追加
    { id: 'page', label: 'Page', desc: 'サブページを作成', keys: ['page', 'ページ'] },
    { id: 'linkpage', label: 'Link to Page', desc: '既存ページへのリンク', keys: ['linkpage', 'ページリンク'] },
    { id: 'h1', label: 'Heading 1', desc: '大見出し', keys: ['h1', '見出し1'] },
    { id: 'h2', label: 'Heading 2', desc: '中見出し', keys: ['h2', '見出し2'] },
    { id: 'h3', label: 'Heading 3', desc: '小見出し', keys: ['h3', '見出し3'] },
    { id: 'todo', label: 'To-do list', desc: 'タスク管理', keys: ['todo', 'タスク'] },
    { id: 'toggle', label: 'Toggle list', desc: '折りたたみリスト', keys: ['toggle', 'トグル'] }
];

let state = { pages: {}, rootPages: [], currentPageId: null, expandedNodes: [], recentPages: [] };
let sortableInstances = [];
let pendingImageTargetBlock = null;

let currentMediaBytes = 0;
const MAX_MEDIA_BYTES = 500 * 1024 * 1024; // 500MB 上限

// ================= 複数ブロック選択・コピペ用の状態と補助関数 =================
let selectedBlocks = new Set();
let isBlockSelecting = false;
let blockSelectionStartIdx = -1;
let lastCtrlATime = 0;

function getFlatBlockElements() {
    return Array.from(document.querySelectorAll('#editor .block-wrapper'));
}

function clearBlockSelection(clearVars = true) {
    document.querySelectorAll('.selected-block').forEach(el => el.classList.remove('selected-block'));
    selectedBlocks.clear();
    if (clearVars) {
        blockSelectionStartIdx = -1;
        isBlockSelecting = false;
    }
}

function extractSingleBlock(wrapper) {
    const type = wrapper.dataset.type;
    const contentEl = wrapper.querySelector(':scope > .block-main > .block-content');
    const fileId = contentEl?.dataset.fileId || null;

    let content = '';
    if (type === 'page_link') content = contentEl?.dataset.linkId || '';
    else if (type === 'image') content = contentEl?.querySelector('img')?.src || '';
else if (type === 'table') {
        const rows = [];
        const widths = [];
        wrapper.querySelectorAll('.motion-table tr').forEach((tr, rIdx) => {
            const r = [];
            tr.querySelectorAll('td').forEach((td, cIdx) => {
                r.push(DOMPurify.sanitize(td.innerHTML, { ALLOWED_TAGS: ['br','b','i','u','s','span'] }));
                if (rIdx === 0) widths.push(td.style.width || '');
            });
            rows.push(r);
        });
        content = JSON.stringify({ widths, rows });
    } else if (contentEl) {
        content = DOMPurify.sanitize(contentEl.innerHTML, { ALLOWED_TAGS: ['a','br','b','strong','i','em','u','s','strike','span'], ALLOWED_ATTR: ['href','target','rel','style','class'] });
    }
    
    const childrenContainer = wrapper.querySelector(':scope > .block-children');
    const children = childrenContainer ? extractBlocks(childrenContainer) : [];

    return { 
        id: wrapper.dataset.id, type, content, fileId, 
        checked: wrapper.classList.contains('checked'), 
        toggleOpen: wrapper.classList.contains('open'), 
        children 
    };
}

function regenerateBlockIds(blocks) {
    return blocks.map(b => ({
        ...b,
        id: generateId(),
        children: b.children && b.children.length > 0 ? regenerateBlockIds(b.children) : []
    }));
}

function convertBlocksToMarkdown(blocks, indent = '') {
    let md = '';
    blocks.forEach(b => {
        let prefix = '';
        if (b.type === 'h1') prefix = '# ';
        else if (b.type === 'h2') prefix = '## ';
        else if (b.type === 'h3') prefix = '### ';
        else if (b.type === 'todo') prefix = b.checked ? '- [x] ' : '- [ ] ';
        else if (b.type === 'toggle') prefix = '> ';

        let text = b.content.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '');
        if (b.type === 'image') text = `![画像](${b.content})`;
        if (b.type === 'page_link') text = `[ページリンク]`;

        md += `${indent}${prefix}${text}\n`;
        if (b.children && b.children.length > 0) md += convertBlocksToMarkdown(b.children, indent + '  ');
    });
    return md;
}

function deleteSelectedBlocks() {
    if (selectedBlocks.size === 0) return;
    const blocks = getFlatBlockElements();
    let firstDeletedIdx = -1;

    blocks.forEach((b, idx) => {
        if (selectedBlocks.has(b.dataset.id)) {
            if (firstDeletedIdx === -1) firstDeletedIdx = idx;
            if (b.dataset.type === 'image') {
                const imgEl = b.querySelector('img');
                const fileId = b.querySelector('.block-content')?.dataset.fileId;
                deleteImageFromStorage(imgEl?.src, fileId);
            }
            b.remove();
        }
    });

    clearBlockSelection();
    saveEditorState(true);

    const newBlocks = getFlatBlockElements();
    if (newBlocks.length === 0) {
        const temp = document.createElement('div');
        renderBlocks([{ id: generateId(), type: 'p', content: '', children: [] }], temp);
        editorEl.appendChild(temp.firstElementChild);
        editorEl.querySelector('.block-content')?.focus();
    } else {
        const targetIdx = Math.max(0, firstDeletedIdx - 1);
        const focusEl = newBlocks[targetIdx]?.querySelector('.block-content');
        if (focusEl) {
            focusEl.focus();
            if (focusEl.contentEditable === "true") setCaretPosition(focusEl, focusEl.textContent.length);
        }
    }
    reinitSortables();
}
// =======================================================================

// Appwrite Storageから画像を削除する処理
async function deleteImageFromStorage(fileUrl, fileId) {
    let idToDelete = fileId;
    if (!idToDelete && fileUrl) {
        const match = fileUrl.match(/\/files\/([^\/?#]+)/);
        if (match) idToDelete = match[1];
    }
    if (idToDelete) {
        try {
            await storage.deleteFile(BUCKET_ID, idToDelete);
            console.log('Storageからファイルを削除しました:', idToDelete);
            calcStorageUsage(); // 容量計算を更新
        } catch (e) {
            console.error('Storage削除エラー:', e);
        }
    }
}

let historyStack = {}; 
let historyIndex = {};

const generateId = () => '_' + Math.random().toString(36).substr(2, 9);
const clone = (obj) => JSON.parse(JSON.stringify(obj));

// ================= Appwrite 初期化 =================
const { Client, Account, Databases, Storage, ID, Query, Permission, Role } = Appwrite;

const client = new Client()
    .setEndpoint('https://nyc.cloud.appwrite.io/v1')
    .setProject('6a75a37300149977659a');

const account = new Account(client);
const databases = new Databases(client);
const storage = new Storage(client);

const DB_ID = 'motion_db';
const COLLECTION_PAGES = 'pages';
const BUCKET_ID = 'motion_storage';

let currentUser = null;

// 設定をクラウドへ保存するヘルパー関数
async function savePrefs(key, value) {
    if (!currentUser) return;
    try {
        const prefs = await account.getPrefs();
        prefs[key] = value;
        await account.updatePrefs(prefs);
    } catch(e) { console.error('Prefs update error:', e); }
}

// ================= 認証・初期化処理 =================
async function initApp() {
    applyTheme();
    
    const savedQuality = localStorage.getItem('motion_image_quality') || 'original';
    const qualitySelect = document.getElementById('setting-image-quality');
    if (qualitySelect) qualitySelect.value = savedQuality;

    // ★ 追加: ローダーのUI要素を取得
    const syncLoader = document.getElementById('appwrite-sync-loader');
    const syncSpinner = syncLoader?.querySelector('.looping-rhombuses-spinner');
    const syncTxt = syncLoader?.querySelector('.txt');

    try {
        // ★ 追加: ログインチェック開始時にローダーのアニメーションとテキストを表示
        if (syncLoader) {
            syncLoader.classList.remove('hidden');
            setTimeout(() => {
                if(syncSpinner) syncSpinner.classList.add('show');
                if(syncTxt) syncTxt.classList.add('show');
            }, 100);
        }

        currentUser = await account.get();
        
        try {
            const userDoc = await databases.getDocument(DB_ID, 'users', currentUser.$id);
            if (userDoc.status !== 'approved') {
                if (syncLoader) syncLoader.classList.add('hidden'); // 未承認時はローダーを消す
                showPendingApprovalModal(currentUser.email);
                return;
            }
        } catch (err) {
            if (syncLoader) syncLoader.classList.add('hidden');
            showPendingApprovalModal(currentUser?.email || '');
            return;
        }

        // --- 承認済みユーザー ---
        document.getElementById('sidebar')?.classList.remove('hidden');
        document.getElementById('main')?.classList.remove('hidden');
        document.getElementById('login-overlay')?.classList.add('hidden');

        const userInfoText = document.getElementById('user-info-text');
        if (userInfoText) {
            userInfoText.textContent = `ログイン中: ${currentUser.name} (${currentUser.email})`;
        }
        
        if (currentUser.email === 'thonglo02cocoa@gmail.com') {
            document.getElementById('tab-btn-admin')?.classList.remove('hidden');
            checkPendingUsersForAdmin();
        }

        try {
            const prefs = await account.getPrefs();
            if (prefs.theme) localStorage.setItem('local_workspace_theme', prefs.theme);
            if (prefs.image_quality) localStorage.setItem('motion_image_quality', prefs.image_quality);
            if (prefs.show_locked !== undefined) localStorage.setItem('motion_show_locked_in_home', prefs.show_locked);
            if (prefs.search_locked !== undefined) localStorage.setItem('motion_search_locked', prefs.search_locked);
        } catch(e) { console.warn('設定の読み込みスキップ:', e); }

        applyTheme();
        const qualitySelectInput = document.getElementById('setting-image-quality');
        if (qualitySelectInput) qualitySelectInput.value = localStorage.getItem('motion_image_quality') || 'original';
        const showLockedInput = document.getElementById('setting-show-locked');
        if (showLockedInput) showLockedInput.checked = (localStorage.getItem('motion_show_locked_in_home') === 'true');
        const searchLockedInput = document.getElementById('setting-search-locked');
        if (searchLockedInput) searchLockedInput.checked = (localStorage.getItem('motion_search_locked') === 'true');

        const savedUi = localStorage.getItem('motion_ui_state');
        if (savedUi) {
            const parsedUi = JSON.parse(savedUi);
            state.expandedNodes = parsedUi.expandedNodes || [];
            state.recentPages = parsedUi.recentPages || [];
        }

        // ★ Appwriteとのデータ同期を実行（ここでロード時間がかかります）
        await loadDataFromAppwrite();

        // ★ 追加: 同期完了！テキストを切り替えてからローダーをフェードアウト
        if (syncLoader) {
            if (syncTxt) syncTxt.textContent = '完了！';
            setTimeout(() => {
                syncLoader.classList.add('hidden');
            }, 500); // 完了の文字を0.5秒見せてから消す
        }

        state.expandedNodes = state.expandedNodes.filter(id => {
            const lockedBy = isPageLocked(id);
            return !lockedBy || lockedBy.isUnlockedSession;
        });

        renderTree();
        openPage('home');
        calcStorageUsage();
    } catch (err) {
        // ★ エラー時（未ログイン状態など）はローダーを隠してログイン画面を出す
        if (syncLoader) syncLoader.classList.add('hidden');
        currentUser = null;
        showAuthModal();
    }
}

// 未承認ユーザー用の停止画面を表示するヘルパー関数
function showPendingApprovalModal(email) {
    const authOverlay = document.getElementById('login-overlay');
    if (!authOverlay) return;

    document.getElementById('sidebar')?.classList.add('hidden');
    document.getElementById('main')?.classList.add('hidden');

    const formContainer = document.querySelector('.login-form-container .modal');
    if (formContainer) {
        formContainer.innerHTML = `
            <h3>承認待ちです</h3>
            <p style="font-size:14px; color:var(--text-main); margin:16px 0; line-height:1.6;">
                アカウント (<strong>${email}</strong>) は現在管理者の承認待ちです。<br>
                承認されるまでご利用いただけません。
            </p>
            <button type="button" id="pending-logout-btn" class="primary-btn" style="margin-bottom:8px;">ログアウトして別のアカウントでログイン</button>
        `;

        document.getElementById('pending-logout-btn').onclick = async () => {
            try {
                await account.deleteSession('current');
            } catch (e) {}
            currentUser = null;
            location.reload();
        };
    }
    authOverlay.classList.remove('hidden');
}

// イベントリスナー: 設定が変更されたらローカルストレージとクラウド両方に保存
document.getElementById('setting-image-quality')?.addEventListener('change', (e) => {
    const val = e.target.value;
    localStorage.setItem('motion_image_quality', val);
    savePrefs('image_quality', val);
});

document.getElementById('setting-show-locked')?.addEventListener('change', (e) => {
    const val = e.target.checked;
    localStorage.setItem('motion_show_locked_in_home', val);
    savePrefs('show_locked', val);
    if(state.currentPageId === 'home') renderHome();
});

document.querySelectorAll('input[name="theme"]').forEach(r => r.onchange = (e) => { 
    const val = r.value;
    localStorage.setItem('local_workspace_theme', val); 
    applyTheme(); 
    savePrefs('theme', val);
});

document.querySelector('.settings-tab[data-tab="account"]')?.addEventListener('click', () => {
    calcStorageUsage();
});

function formatBytes(bytes) {
    if (bytes === 0) return '0 Bytes';
    if (bytes < 1024) return `${bytes} Bytes`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

async function calcStorageUsage() {
    const usageText = document.getElementById('storage-usage-text');
    const limitText = document.getElementById('storage-limit-text');
    const barFill = document.getElementById('storage-bar-fill');
    if (!usageText) return;

    let textBytes = 0;
    Object.values(state.pages).forEach(page => {
        const blocksData = page.blocks || [];
        const pageString = typeof blocksData === 'string' ? blocksData : JSON.stringify(blocksData);
        textBytes += new Blob([pageString]).size;
    });

    usageText.innerHTML = `テキストデータ: ${formatBytes(textBytes)}<br>添付ファイル: 計算中...`;

    try {
        if (currentUser) {
            const fileList = await storage.listFiles(BUCKET_ID);
            currentMediaBytes = fileList.files.reduce((sum, file) => sum + (file.sizeOriginal || 0), 0);
        }
    } catch (err) {
        console.error("ストレージ使用量取得エラー:", err);
    }

    usageText.innerHTML = `テキストデータ: ${formatBytes(textBytes)}<br>添付ファイル: ${formatBytes(currentMediaBytes)}`;
    
    if (limitText && barFill) {
        const percent = Math.min((currentMediaBytes / MAX_MEDIA_BYTES) * 100, 100);
        barFill.style.width = `${percent}%`;
        barFill.classList.remove('warning', 'danger');
        
        const warningText = document.getElementById('storage-warning-text');
        
        if (percent >= 90) {
            barFill.classList.add('danger');
            if(warningText) warningText.classList.remove('hidden');
        }
        else if (percent >= 70) {
            barFill.classList.add('warning');
            if(warningText) warningText.classList.add('hidden');
        } else {
            if(warningText) warningText.classList.add('hidden');
        }
        
        limitText.textContent = `${formatBytes(currentMediaBytes)} / 500.00 MB (${percent.toFixed(1)}%)`;
    }
}

const usernameToEmail = (username) => `${username.toLowerCase()}@motion.local`;
let tempAuthData = null;

function showAuthModal() {
    const authOverlay = document.getElementById('login-overlay');
    if (!authOverlay) return;

    document.getElementById('sidebar')?.classList.add('hidden');
    document.getElementById('main')?.classList.add('hidden');

    const usernameInput = document.getElementById('auth-username');
    const passwordInput = document.getElementById('auth-password');
    const authSubmit = document.getElementById('auth-submit-btn');
    const authToggle = document.getElementById('auth-toggle-btn');
    const authForm = document.getElementById('auth-form');
    const confirmInput = document.getElementById('auth-password-confirm');
    const confirmWrapper = document.getElementById('auth-password-confirm-wrapper');

    let otpContainer = document.getElementById('otp-container');
    if (!otpContainer) {
        otpContainer = document.createElement('div');
        otpContainer.id = 'otp-container';
        otpContainer.className = 'hidden';
        otpContainer.innerHTML = `
            <p style="font-size:14px; margin-bottom:12px; color:var(--text-main);">メールに送信された6桁の認証コードを入力してください。</p>
            <input type="text" id="auth-otp" placeholder="6桁のコード" maxlength="6" style="margin-bottom:12px;">
            <button type="button" id="auth-otp-submit" class="primary-btn">認証して申請</button>
            <button type="button" id="auth-otp-cancel" class="cancel-btn">キャンセル</button>
        `;
        authForm.appendChild(otpContainer);
    }

    let inputsWrapper = document.getElementById('auth-inputs-wrapper');
    if (!inputsWrapper) {
        inputsWrapper = document.createElement('div');
        inputsWrapper.id = 'auth-inputs-wrapper';
        usernameInput.parentNode.insertBefore(inputsWrapper, usernameInput);
        inputsWrapper.append(usernameInput, passwordInput.parentNode, confirmWrapper, authSubmit, authToggle);
    }

    usernameInput.value = '';
    passwordInput.value = '';
    if (confirmInput) confirmInput.value = '';
    inputsWrapper.classList.remove('hidden');
    otpContainer.classList.add('hidden');
    authOverlay.classList.remove('hidden');
    let isSignUp = false;

    authToggle.onclick = () => {
        isSignUp = !isSignUp;
        document.getElementById('auth-title').textContent = isSignUp ? 'アカウント作成' : 'ログイン';
        authSubmit.textContent = isSignUp ? 'アカウントを作成' : 'ログイン';
        authToggle.textContent = isSignUp ? 'ログインへ切替' : 'アカウント作成へ切替';
        usernameInput.value = '';
        passwordInput.value = '';
        if (confirmInput) confirmInput.value = '';
        passwordInput.setAttribute('autocomplete', isSignUp ? 'new-password' : 'current-password');
        
        if (isSignUp) {
            confirmWrapper?.classList.remove('hidden');
        } else {
            confirmWrapper?.classList.add('hidden');
        }
    };

    authSubmit.onclick = async () => {
        const email = usernameInput.value.trim();
        const pass = passwordInput.value.trim();
        const confirmPass = confirmInput ? confirmInput.value.trim() : '';

        if (!email || !pass) return alert('メールアドレスとパスワードを入力してください');
        if (!email.includes('@') || !email.includes('.')) {
            return alert('有効なメールアドレスを入力してください');
        }

        if (isSignUp) {
            if (pass !== confirmPass) {
                return alert('パスワードと確認用パスワードが一致しません');
            }
            if (pass.length < 8) {
                return alert('パスワードは8文字以上で設定してください');
            }
        }

        try {
            if (isSignUp) {
                const newUser = await account.create(ID.unique(), email, pass);
                await account.createEmailSession(email, pass);
                await databases.createDocument(
                    DB_ID, 'users', newUser.$id, 
                    { email: email, status: 'pending' },
                    [
                        Permission.read(Role.any()),
                        Permission.update(Role.user(newUser.$id)),
                        Permission.delete(Role.user(newUser.$id))
                    ]
                );
                await sendAdminRequestEmail(email);
                await account.deleteSession('current');
                alert('アカウントを作成しました。管理者の承認をお待ちください。');
                location.reload();
            } else {
                try {
                    await account.deleteSession('current');
                } catch (e) {}
                await account.createEmailSession(email, pass);
                usernameInput.value = '';
                passwordInput.value = '';
                authOverlay.classList.add('hidden');
                location.reload();
            }
        } catch (e) {
            alert(`エラー: ${e.message}`);
        }
    };

    document.getElementById('auth-otp-submit').onclick = async () => {
        const secret = document.getElementById('auth-otp').value.trim();
        if(!secret) return alert('認証コードを入力してください');
        try {
            await account.createSession(tempAuthData.userId, secret);
            await databases.createDocument(DB_ID, 'users', tempAuthData.userId, { email: tempAuthData.email, status: 'pending' });
            await sendAdminRequestEmail(tempAuthData.email);
            await account.deleteSession('current');
            alert('管理者にアカウント開設のリクエストを送りました。承認されるまでお待ちください。');
            location.reload();
        } catch (e) {
            alert(`認証エラー: ${e.message}`);
        }
    };

    document.getElementById('auth-otp-cancel').onclick = () => {
        inputsWrapper.classList.remove('hidden');
        otpContainer.classList.add('hidden');
        document.getElementById('auth-title').textContent = 'アカウント作成';
        tempAuthData = null;
    };
}

document.getElementById('btn-change-pass')?.addEventListener('click', async () => {
    const oldPass = document.getElementById('change-pass-old').value;
    const newPass = document.getElementById('change-pass-new').value;
    if (!oldPass || !newPass) return alert('旧パスワードと新パスワードを入力してください');

    try {
        await account.updatePassword(newPass, oldPass);
        alert('パスワードを変更しました。');
        document.getElementById('change-pass-old').value = '';
        document.getElementById('change-pass-new').value = '';
    } catch (e) {
        alert(`変更失敗: ${e.message}`);
    }
});

document.getElementById('btn-logout')?.addEventListener('click', async () => {
    await account.deleteSession('current');
    location.reload();
});

// ================= Appwrite データ同期 =================
// ================= Appwrite データ同期 =================
async function loadDataFromAppwrite() {
    try {
        state.pages = {};
        state.rootPages = [];
        const pageMap = {};

        let hasMore = true;
        let lastId = null;

        while (hasMore) {
            // ★変更: blocks を除外してメタデータだけを取得する
            const queries = [
                Query.limit(100),
                Query.select(["pageId", "title", "parentId", "isLocked", "password"])
            ];
            if (lastId) {
                queries.push(Query.cursorAfter(lastId));
            }

            const response = await databases.listDocuments(DB_ID, COLLECTION_PAGES, queries);

            for (const doc of response.documents) {
                if (!pageMap[doc.pageId]) {
                    pageMap[doc.pageId] = doc;
                } else {
                    try {
                        await databases.deleteDocument(DB_ID, COLLECTION_PAGES, doc.$id);
                    } catch (e) {}
                }
            }

            if (response.documents.length < 100) {
                hasMore = false;
            } else {
                lastId = response.documents[response.documents.length - 1].$id;
            }
        }

        Object.values(pageMap).forEach(doc => {
            state.pages[doc.pageId] = {
                id: doc.pageId,
                title: doc.title || '',
                parentId: doc.parentId || null,
                blocks: null, // ★変更: 初期状態は未読み込み（null）とする
                isLocked: doc.isLocked || false,
                password: doc.password || null,
                $id: doc.$id
            };
            if (!doc.parentId) state.rootPages.push(doc.pageId);
        });

        if (Object.keys(state.pages).length === 0) {
            const id = generateId();
            const initialPage = { 
                id, 
                title: 'はじめに', 
                parentId: null, 
                blocks: [{ id: generateId(), type: 'p', content: 'Welcome to Motion!', children: [] }], 
                isLocked: false 
            };
            state.pages[id] = initialPage;
            state.rootPages.push(id);
            await createPageInAppwrite(initialPage);
        }
    } catch (e) {
        console.error('Data load error:', e);
    }
}

async function createPageInAppwrite(page) {
    if (!currentUser) return;
    
    const payload = {
        pageId: page.id,
        title: page.title || '',
        parentId: page.parentId || null,
        blocks: JSON.stringify(page.blocks),
        isLocked: page.isLocked || false,
        password: page.password || null
    };

    const permissions = [
        Permission.read(Role.user(currentUser.$id)),
        Permission.update(Role.user(currentUser.$id)),
        Permission.delete(Role.user(currentUser.$id))
    ];

    try {
        const doc = await databases.createDocument(DB_ID, COLLECTION_PAGES, ID.unique(), payload, permissions);
        page.$id = doc.$id;
    } catch (e) {
        console.error('Create page error:', e);
    }
}

async function saveDataToAppwrite(pageTarget) {
    if (!currentUser) return;
    const page = pageTarget || state.pages[state.currentPageId];
    if (!page || page.id === 'home') return;

    if (!page.$id) {
        await createPageInAppwrite(page);
        return;
    }

    const payload = {
        pageId: page.id,
        title: page.title || '',
        parentId: page.parentId || null,
        blocks: JSON.stringify(page.blocks),
        isLocked: page.isLocked || false,
        password: page.password || null
    };

    try {
        await databases.updateDocument(DB_ID, COLLECTION_PAGES, page.$id, payload);
    } catch (e) {
        console.error('Update error:', e);
    }
}

async function saveData() {
    if (state.currentPageId && state.currentPageId !== 'home') {
        await saveDataToAppwrite(state.pages[state.currentPageId]);
    }
    const uiState = {
        expandedNodes: state.expandedNodes,
        recentPages: state.recentPages
    };
    localStorage.setItem('motion_ui_state', JSON.stringify(uiState));
}

(async () => {
    await initApp();
})();

function isPageLocked(pageId) {
    let currentId = pageId;
    while(currentId) {
        const p = state.pages[currentId];
        if(!p) break;
        if(p.isLocked) return p;
        currentId = p.parentId;
    }
    return null;
}

document.getElementById('setting-search-locked')?.addEventListener('change', (e) => {
    const val = e.target.checked;
    localStorage.setItem('motion_search_locked', val);
    savePrefs('search_locked', val);
});

function applyTheme() {
    const theme = localStorage.getItem('local_workspace_theme') || 'light';
    document.body.classList.toggle('dark-mode', theme === 'dark');
    document.querySelectorAll('input[name="theme"]').forEach(r => r.checked = (r.value === theme));
}

// ================= Undo / Redo =================
function pushHistory(pageId) {
    if (!historyStack[pageId]) { historyStack[pageId] = []; historyIndex[pageId] = -1; }
    const currentBlocks = clone(state.pages[pageId].blocks);
    
    if(historyIndex[pageId] >= 0) {
        const lastBlocks = historyStack[pageId][historyIndex[pageId]];
        if(JSON.stringify(currentBlocks) === JSON.stringify(lastBlocks)) return;
    }
    historyStack[pageId] = historyStack[pageId].slice(0, historyIndex[pageId] + 1);
    historyStack[pageId].push(currentBlocks);
    if(historyStack[pageId].length > 50) historyStack[pageId].shift();
    else historyIndex[pageId]++;
}
function executeUndo(pageId) {
    if (!historyStack[pageId] || historyIndex[pageId] <= 0) return;
    historyIndex[pageId]--;
    state.pages[pageId].blocks = clone(historyStack[pageId][historyIndex[pageId]]);
    renderEditor(state.pages[pageId]); saveData();
}
function executeRedo(pageId) {
    if (!historyStack[pageId] || historyIndex[pageId] >= historyStack[pageId].length - 1) return;
    historyIndex[pageId]++;
    state.pages[pageId].blocks = clone(historyStack[pageId][historyIndex[pageId]]);
    renderEditor(state.pages[pageId]); saveData();
}

document.addEventListener('keydown', (e) => {
    if (selectedBlocks.size > 0 && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        clearBlockSelection();
    }

    if (selectedBlocks.size > 0 && e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
        e.preventDefault();
        const blocks = getFlatBlockElements();
        const selectedArray = blocks.filter(b => selectedBlocks.has(b.dataset.id));
        if (selectedArray.length === 0) return;

        const firstIdx = blocks.indexOf(selectedArray[0]);
        const lastIdx = blocks.indexOf(selectedArray[selectedArray.length - 1]);

        if (e.key === 'ArrowUp') {
            if (lastIdx > blockSelectionStartIdx) {
                const target = blocks[lastIdx];
                target.classList.remove('selected-block');
                selectedBlocks.delete(target.dataset.id);
            } else if (firstIdx > 0) {
                const target = blocks[firstIdx - 1];
                target.classList.add('selected-block');
                selectedBlocks.add(target.dataset.id);
            }
        } else if (e.key === 'ArrowDown') {
            if (firstIdx < blockSelectionStartIdx) {
                const target = blocks[firstIdx];
                target.classList.remove('selected-block');
                selectedBlocks.delete(target.dataset.id);
            } else if (lastIdx < blocks.length - 1) {
                const target = blocks[lastIdx + 1];
                target.classList.add('selected-block');
                selectedBlocks.add(target.dataset.id);
            }
        }
        return;
    }

    if (e.key === 'Escape') {
        if (selectedBlocks.size > 0) {
            clearBlockSelection();
            return;
        }
        document.getElementById('search-overlay')?.classList.add('hidden');
        document.getElementById('floating-menu')?.classList.add('hidden');
        document.getElementById('overlay')?.classList.add('hidden');
        document.getElementById('link-overlay')?.classList.add('hidden');
        document.getElementById('ext-link-overlay')?.classList.add('hidden');
        document.getElementById('settings-overlay')?.classList.add('hidden');
        closeSlashMenu();
        document.getElementById('context-menu')?.classList.add('hidden');
        return;
    }

    if ((e.key === 'Backspace' || e.key === 'Delete') && selectedBlocks.size > 0) {
        e.preventDefault();
        deleteSelectedBlocks();
        return;
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        const inEditor = e.target.closest('#editor');
        if (inEditor || selectedBlocks.size > 0) {
            const now = Date.now();
            const activeBlock = document.activeElement.closest('.block-wrapper');
            
            if (now - lastCtrlATime < 500 || (!activeBlock && selectedBlocks.size === 0)) {
                e.preventDefault();
                window.getSelection().removeAllRanges();
                const blocks = getFlatBlockElements();
                clearBlockSelection(false);
                blocks.forEach(b => {
                    b.classList.add('selected-block');
                    selectedBlocks.add(b.dataset.id);
                });
            } else {
                if (selectedBlocks.size > 0) clearBlockSelection();
            }
            lastCtrlATime = now;
        }
    }

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
        e.preventDefault();
        if (e.shiftKey) executeRedo(state.currentPageId);
        else executeUndo(state.currentPageId);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        if (e.target.tagName === 'INPUT') return;
        e.preventDefault(); executeRedo(state.currentPageId);
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'p') {
        e.preventDefault(); openSearchModal();
    }
});

// ================= サイドバー・ツリー描画 =================
const sidebar = document.getElementById('sidebar'), sidebarOverlay = document.getElementById('sidebar-overlay'), treeEl = document.getElementById('tree'), editorEl = document.getElementById('editor'), pageTitleEl = document.getElementById('page-title');
let contextMenuTargetId = null;
const contextMenuEl = document.getElementById('context-menu');

function renderTree() {
    if(!treeEl) return;
    treeEl.innerHTML = '';
    const buildTree = (pageIds, container, level) => {
        pageIds.forEach(id => {
            const page = state.pages[id]; if (!page) return;
            const children = Object.values(state.pages).filter(p => p.parentId === id).map(p => p.id);
            const item = document.createElement('div');
            item.className = `tree-item ${state.currentPageId === id ? 'active' : ''}`;
            item.style.paddingLeft = `${16 + level * 16}px`;
            
            const lockedBy = isPageLocked(id);
            const isUnlocked = !lockedBy || lockedBy.isUnlockedSession;
            const isExpanded = isUnlocked && state.expandedNodes.includes(id);
            
            const toggle = document.createElement('div'); toggle.className = 'tree-toggle';
            toggle.innerHTML = children.length > 0 ? (isExpanded ? '▼' : '▶') : '•';
            
            const title = document.createElement('div'); title.className = 'tree-title';
            let titleText = page.title || '無題';
            if (page.isLocked) {
                const icon = page.isUnlockedSession ? '🔓' : '🔒';
                titleText = `${icon} ${titleText}`;
            }
            title.textContent = titleText;
            
            item.append(toggle, title);
            
            item.onclick = (e) => {
                if(e.target === toggle && children.length > 0) {
                    const isHidden = childContainer.classList.contains('hidden');
                    if (isHidden) {
                        const lockedBy = isPageLocked(id);
                        if (lockedBy && !lockedBy.isUnlockedSession) {
                            e.stopPropagation();
                            showPasswordModal(lockedBy.id, () => {
                                if (!state.expandedNodes.includes(id)) state.expandedNodes.push(id);
                                saveData(); renderTree();
                            });
                            return;
                        }
                        childContainer.classList.remove('hidden'); toggle.innerHTML = '▼';
                        if (!state.expandedNodes.includes(id)) state.expandedNodes.push(id);
                    } else {
                        childContainer.classList.add('hidden'); toggle.innerHTML = '▶';
                        state.expandedNodes = state.expandedNodes.filter(n => n !== id);
                    }
                    saveData(); e.stopPropagation(); return;
                }
                openPage(id);
            };
            item.oncontextmenu = (e) => {
                e.preventDefault(); e.stopPropagation(); contextMenuTargetId = id;
                contextMenuEl.style.top = `${e.pageY}px`; contextMenuEl.style.left = `${e.pageX}px`; contextMenuEl.classList.remove('hidden');
            };
            container.appendChild(item);

            const childContainer = document.createElement('div');
            childContainer.className = `tree-children ${isExpanded ? '' : 'hidden'}`;
            if (children.length > 0) buildTree(children, childContainer, level + 1);
            container.appendChild(childContainer);
        });
    };
    buildTree(state.rootPages, treeEl, 0);
    document.getElementById('btn-home').classList.toggle('active', state.currentPageId === 'home');
}

document.getElementById('sidebar-toggle-btn').addEventListener('click', () => { sidebar.classList.add('open'); sidebarOverlay.classList.add('active'); });
sidebarOverlay.addEventListener('click', () => { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); });

document.getElementById('add-page-btn').addEventListener('click', async () => {
    const id = generateId(); 
    const newPage = { 
        id, 
        title: '', 
        parentId: null, 
        blocks: [{ id: generateId(), type: 'p', content: '', children: [] }] 
    };
    state.pages[id] = newPage;
    state.rootPages.push(id); 
    await createPageInAppwrite(newPage);
    saveData(); 
    renderTree(); 
    openPage(id); 
    setTimeout(() => pageTitleEl.focus(), 10);
});

document.getElementById('ctx-add-subpage')?.addEventListener('click', async () => {
    const childId = generateId();
    const childPage = { 
        id: childId, 
        title: '', 
        parentId: contextMenuTargetId, 
        blocks: [{ id: generateId(), type: 'p', content: '', children: [] }] 
    };
    state.pages[childId] = childPage;
    if(!state.expandedNodes.includes(contextMenuTargetId)) state.expandedNodes.push(contextMenuTargetId);
    await createPageInAppwrite(childPage);
    saveData(); 
    renderTree(); 
    openPage(childId); 
    setTimeout(() => pageTitleEl?.focus(), 10);
});

document.getElementById('ctx-delete-page')?.addEventListener('click', () => {
    contextMenuEl?.classList.add('hidden');
    if(confirm("このページと中のコンテンツを全て削除しますか？")) {
        const deleteRecursive = async (id) => {
            const children = Object.values(state.pages).filter(p => p.parentId === id);
            for (const child of children) {
                await deleteRecursive(child.id);
            }
            const page = state.pages[id];
            if (page && page.$id) {
                try {
                    await databases.deleteDocument(DB_ID, COLLECTION_PAGES, page.$id);
                } catch (err) {
                    console.error('Server delete error:', err);
                }
            }
            delete state.pages[id]; 
            state.rootPages = state.rootPages.filter(rid => rid !== id);
            state.expandedNodes = state.expandedNodes.filter(rid => rid !== id);
            state.recentPages = state.recentPages.filter(rid => rid !== id);
        };
        (async () => {
            await deleteRecursive(contextMenuTargetId);
            await saveData(); 
            if(state.currentPageId === contextMenuTargetId) openPage('home');
            else renderTree();
        })();
    }
});
document.addEventListener('click', (e) => { if (!e.target.closest('#context-menu')) contextMenuEl?.classList.add('hidden'); });

function updateBreadcrumb(pageId) {
    const breadcrumbEl = document.getElementById('breadcrumb');
    if (pageId === 'home') { breadcrumbEl.innerHTML = ''; return; }
    
    let path = [], currentId = pageId;
    while (currentId) { const p = state.pages[currentId]; if (!p) break; path.unshift(p); currentId = p.parentId; }
    breadcrumbEl.innerHTML = '';
    path.forEach((p, i) => {
        const span = document.createElement('span'); span.className = 'breadcrumb-item'; span.textContent = p.title || '無題'; span.onclick = () => openPage(p.id);
        breadcrumbEl.appendChild(span);
        if (i < path.length - 1) { const sep = document.createElement('span'); sep.className = 'breadcrumb-separator'; sep.textContent = '/'; breadcrumbEl.appendChild(sep); }
    });
}

function trackRecentPage(id) {
    if (!state.recentPages) state.recentPages = [];
    state.recentPages = state.recentPages.filter(pid => pid !== id);
    state.recentPages.unshift(id);
    if(state.recentPages.length > 12) state.recentPages.pop();
    saveData();
}

function renderHome() {
    const container = document.getElementById('home-recent-pages');
    container.innerHTML = '';
    const showLocked = localStorage.getItem('motion_show_locked_in_home') === 'true';
    
    let displayPages = [];
    if (state.recentPages) {
        state.recentPages.forEach(pid => {
            if (state.pages[pid]) {
                const lockedBy = isPageLocked(pid);
                if (lockedBy && !showLocked) return;
                displayPages.push(state.pages[pid]);
            }
        });
    }

    if (displayPages.length === 0) {
        container.innerHTML = '<div style="color:var(--text-muted); font-size:14px;">履歴はありません</div>';
        return;
    }

    displayPages.forEach(p => {
        const card = document.createElement('div');
        card.className = 'recent-page-card';
        card.innerHTML = `<svg class="icon"><use href="#icon-page"></use></svg> <span>${p.title || '無題'}</span>`;
        if (p.isLocked) {
            card.innerHTML += `<svg class="icon" style="margin-left:auto; width:14px; height:14px;"><use href="#icon-lock"></use></svg>`;
        }
        card.onclick = () => openPage(p.id);
        container.appendChild(card);
    });
}

document.getElementById('btn-home').addEventListener('click', () => openPage('home'));


async function openPage(id) {
    if (id === 'home') {
        state.currentPageId = 'home';
        document.getElementById('editor-wrapper').classList.add('hidden');
        document.getElementById('empty-state').classList.add('hidden');
        document.getElementById('inline-loading').classList.add('hidden'); // ★追加
        document.getElementById('home-wrapper').classList.remove('hidden');
        document.getElementById('mobile-topbar-title').textContent = 'Motion';
        renderTree(); renderHome(); updateBreadcrumb('home');
        if (window.innerWidth <= 1024) { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); }
        return;
    }

    const lockedBy = isPageLocked(id);
    if (lockedBy && !lockedBy.isUnlockedSession) {
        showPasswordModal(lockedBy.id, () => {
            if (!state.expandedNodes.includes(lockedBy.id)) {
                state.expandedNodes.push(lockedBy.id);
                saveData();
            }
            openPage(id);
        }); 
        return; 
    }
    
    const page = state.pages[id];

    // ★追加: 既存の表示を隠し、ローディングを表示
    document.getElementById('empty-state').classList.add('hidden'); 
    document.getElementById('home-wrapper').classList.add('hidden');
    
    // まだ読み込まれていない場合のみローディングUIを出す
    if (page.blocks === null) {
        document.getElementById('editor-wrapper').classList.add('hidden');
        document.getElementById('inline-loading').classList.remove('hidden');
        
        if (page.$id) {
            try {
                const doc = await databases.getDocument(DB_ID, COLLECTION_PAGES, page.$id, [
                    Query.select(["blocks"])
                ]);
                let parsedBlocks = doc.blocks;
                if (typeof parsedBlocks === 'string') {
                    try { parsedBlocks = JSON.parse(parsedBlocks); } catch (err) { parsedBlocks = []; }
                }
                if (!Array.isArray(parsedBlocks)) {
                    parsedBlocks = [{ id: generateId(), type: 'p', content: '', children: [] }];
                }
                page.blocks = parsedBlocks;
            } catch (err) {
                console.error("Failed to load blocks:", err);
                page.blocks = [{ id: generateId(), type: 'p', content: '読み込みエラーが発生しました。', children: [] }];
            }
        } else {
            page.blocks = [{ id: generateId(), type: 'p', content: '', children: [] }];
        }
    }

    // ★追加: 読み込み完了後、ローディングを隠してエディタを表示
    document.getElementById('inline-loading').classList.add('hidden');
    document.getElementById('editor-wrapper').classList.remove('hidden');

    trackRecentPage(id);
    state.currentPageId = id; renderTree(); updateBreadcrumb(id);
    
    pageTitleEl.textContent = page.title || '';
    document.getElementById('mobile-topbar-title').textContent = page.title || '無題';
    
    const lockBtn = document.getElementById('lock-btn');
    if (page.isLocked) { lockBtn.classList.add('locked'); document.getElementById('lock-text').textContent = 'ロックを解除'; }
    else { lockBtn.classList.remove('locked'); document.getElementById('lock-text').textContent = 'ロック'; }
    
    if(!historyStack[id]) pushHistory(id);
    renderEditor(page);
    if (window.innerWidth <= 1024) { sidebar.classList.remove('open'); sidebarOverlay.classList.remove('active'); }

    // ★追加: 画面描画が終わった後、裏側（非同期）で子ページをプリフェッチする
    prefetchChildren(id);
}

async function prefetchChildren(parentId) {
    // 現在のページの子ページをすべて取得
    const children = Object.values(state.pages).filter(p => p.parentId === parentId);
    
    // すでに読み込み済みのものを除外
    const toFetch = children.filter(p => p.blocks === null && p.$id);
    
    if (toFetch.length === 0) return;

    // 並行してAppwriteから取得（※あまりに多いとAPI制限に引っかかる可能性があるため注意）
    const promises = toFetch.map(async (page) => {
        try {
            const doc = await databases.getDocument(DB_ID, COLLECTION_PAGES, page.$id, [
                Query.select(["blocks"])
            ]);
            let parsedBlocks = doc.blocks;
            if (typeof parsedBlocks === 'string') {
                try { parsedBlocks = JSON.parse(parsedBlocks); } catch (err) { parsedBlocks = []; }
            }
            if (!Array.isArray(parsedBlocks)) {
                parsedBlocks = [{ id: generateId(), type: 'p', content: '', children: [] }];
            }
            // 裏側でこっそりデータをセットしておく
            page.blocks = parsedBlocks;
        } catch(e) {
            console.warn('Prefetch failed for:', page.id, e);
        }
    });

    // 取得完了を待たない（Promise.allSettledを使ってバックグラウンドで処理させる）
    Promise.allSettled(promises);
}

let titleDebounceTimer = null;
pageTitleEl.addEventListener('input', (e) => {
    const val = e.target.textContent;
    state.pages[state.currentPageId].title = val; 
    document.getElementById('mobile-topbar-title').textContent = val || '無題';
    renderTree(); 
    updateBreadcrumb(state.currentPageId);
    document.querySelectorAll(`.block-content[data-link-id="${state.currentPageId}"]`).forEach(el => el.innerHTML = `📄 ${val || '無題'}`);

    clearTimeout(titleDebounceTimer);
    titleDebounceTimer = setTimeout(async () => {
        await saveData();
    }, 200);
});

pageTitleEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { 
        e.preventDefault(); 
        const firstBlock = document.querySelector('#editor .block-content'); 
        if (firstBlock) {
            firstBlock.focus();
            if (firstBlock.contentEditable === "true") {
                setCaretPosition(firstBlock, 0);
            }
        }
    }
});

const overlayIds = ['overlay', 'search-overlay', 'link-overlay', 'ext-link-overlay', 'settings-overlay'];
overlayIds.forEach(id => {
    document.getElementById(id)?.addEventListener('click', e => {
        if (e.target.id === id) {
            if (id === 'overlay') document.getElementById('modal-cancel')?.click();
            else if (id === 'link-overlay') document.getElementById('link-cancel')?.click();
            else if (id === 'ext-link-overlay') document.getElementById('ext-link-cancel')?.click();
            else if (id === 'settings-overlay') document.getElementById('settings-close')?.click();
            else e.target.classList.add('hidden');
        }
    });
});

function showPasswordModal(lockParentId, onSuccess) {
    const overlay = document.getElementById('overlay'), modalPass = document.getElementById('modal-pass');
    overlay.classList.remove('hidden'); 
    modalPass.value = ''; 
    modalPass.focus();
    
    document.getElementById('modal-submit').onclick = () => {
        const pass = modalPass.value; 
        const parentPage = state.pages[lockParentId];
        
        // ★追加：入力されたパスワードを暗号化
        const inputHash = CryptoJS.SHA256(pass).toString();

        // ★追加：保存されている暗号化パスワードと一致するか検証
        if (inputHash === parentPage.password) {
            parentPage.isUnlockedSession = true;
            modalPass.value = '';
            overlay.classList.add('hidden'); 
            if(onSuccess) onSuccess();
        } else {
            // 一致しない場合はエラーを出して再入力を促す
            alert("パスワードが間違っています。");
            modalPass.value = '';
            modalPass.focus();
        }
    };
}

document.getElementById('modal-cancel')?.addEventListener('click', () => document.getElementById('overlay').classList.add('hidden'));
document.getElementById('lock-btn')?.addEventListener('click', () => {
    const page = state.pages[state.currentPageId];
    if (page.isLocked) {
        if(confirm("パスワード保護を解除しますか？")) {
            page.isLocked = false; page.password = null; page.isUnlockedSession = false;
            saveEditorState(true); openPage(state.currentPageId);
        }
    } else {
        const pass = prompt("このページをロックするためのパスワードを入力してください:");
        if (pass) {
            page.isLocked = true;
            page.password = CryptoJS.SHA256(pass).toString();
            page.isUnlockedSession = false;
            saveEditorState(true); 
            const currentId = state.currentPageId; state.currentPageId = null;
            document.getElementById('editor-wrapper').classList.add('hidden'); document.getElementById('empty-state').classList.remove('hidden');
            state.expandedNodes = state.expandedNodes.filter(id => !isPageLocked(id));
            saveData().then(() => { renderTree(); openPage(currentId); });
        }
    }
});

// ================= エディタ描画と保存 =================
function renderEditor(page) {
    editorEl.innerHTML = ''; 
    let blocks = page.blocks;
    if (!blocks || !Array.isArray(blocks) || blocks.length === 0) {
        blocks = [{ id: generateId(), type: 'p', content: '', children: [] }];
        page.blocks = blocks;
    }
    renderBlocks(blocks, editorEl); 
    reinitSortables();
}

function renderBlocks(blockArray, container) {
    blockArray.forEach(blockData => {
        const wrapper = document.createElement('div'); 
        wrapper.className = 'block-wrapper'; 
        wrapper.dataset.id = blockData.id; 
        wrapper.dataset.type = blockData.type || 'p';
        if(blockData.checked) wrapper.classList.add('checked'); 
        if(blockData.toggleOpen) wrapper.classList.add('open');

        const main = document.createElement('div'); 
        main.className = 'block-main';
        
        main.innerHTML = `<div class="drag-handle" onmouseup="if(!window.isDraggingBlock) showBlockMenu(event, this)"><svg class="icon"><use href="#icon-grip"></use></svg></div>`;
        
        if (blockData.type === 'todo') { 
            const cb = document.createElement('div'); 
            cb.className = 'todo-checkbox'; 
            cb.onclick = () => { wrapper.classList.toggle('checked'); saveEditorState(true); }; 
            main.appendChild(cb); 
        }
        if (blockData.type === 'toggle') { 
            const tg = document.createElement('div'); 
            tg.className = 'toggle-icon'; 
            tg.innerHTML = '<svg class="icon"><use href="#icon-toggle"></use></svg>'; 
            tg.onclick = () => { wrapper.classList.toggle('open'); saveEditorState(true); }; 
            main.appendChild(tg); 
        }

        const content = document.createElement('div'); 
        content.className = 'block-content'; 
        content.dataset.placeholder = "'/' または MarkDown記法 (#, [], >)";
        
        if (blockData.type === 'page_link') {
            content.contentEditable = "false"; 
            content.tabIndex = 0; 
            content.dataset.linkId = blockData.content;
            const target = state.pages[blockData.content];
            content.innerHTML = target ? `📄 ${target.title || '無題'}` : `📄 削除されたページ`;
            if(target) content.onclick = () => openPage(blockData.content);
            content.addEventListener('keydown', handleNonTextKeydown);
        } else if (blockData.type === 'image') {
            content.contentEditable = "false"; 
            content.tabIndex = 0;
            if (blockData.fileId) content.dataset.fileId = blockData.fileId;
            content.innerHTML = `<img src="${blockData.content}" alt="画像">`;
            content.onclick = () => content.focus();
            content.addEventListener('keydown', handleNonTextKeydown);
        }else if (blockData.type === 'table') {
            content.contentEditable = "false"; 
            content.tabIndex = 0;
            
            // 旧フォーマットと新フォーマットの互換性維持
            let tData = { widths: [], rows: [["", ""], ["", ""]] };
            try { 
                if (blockData.content) {
                    const parsed = JSON.parse(blockData.content);
                    if (Array.isArray(parsed)) tData.rows = parsed; 
                    else if (parsed.rows) tData = parsed; 
                }
            } catch(e) {
                if (blockData.content) tData.rows[0][0] = blockData.content;
            }
            if (!Array.isArray(tData.rows) || tData.rows.length === 0) tData.rows = [["", ""], ["", ""]];
            if (!tData.widths) tData.widths = [];

            // ★追加: 現在フォーカスしている（アクティブな）セルを記録
            let activeCell = { r: 0, c: 0 };

            const renderTable = (data) => {
                content.innerHTML = '';
                const table = document.createElement('table');
                table.className = 'motion-table';
                data.rows.forEach((row, rIdx) => {
                    const tr = document.createElement('tr');
                    row.forEach((cell, cIdx) => {
                        const td = document.createElement('td');
                        td.contentEditable = "true";
                        td.innerHTML = cell;
                        
                        if (rIdx === 0 && data.widths[cIdx]) td.style.width = data.widths[cIdx];
                        
                        td.addEventListener('input', () => saveEditorState());
                        
                        // ★追加: セルがクリック/フォーカスされたら位置を記録
                        td.addEventListener('focus', () => {
                            activeCell = { r: rIdx, c: cIdx };
                        });
                        
                        td.addEventListener('keydown', (e) => {
                            // ★修正: 'Enter' を追加し、イベント伝播を止めて表外にブロックが作られるのを防ぐ
                            if (['Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter'].includes(e.key)) {
                                e.stopPropagation();
                            }
                            
                            if (e.key === 'ArrowRight' && isCaretAtEnd(td)) {
                                e.preventDefault(); const nextTd = td.nextElementSibling;
                                if(nextTd) { nextTd.focus(); setCaretPosition(nextTd, 0); }
                            } else if (e.key === 'ArrowLeft' && isCaretAtStart(td)) {
                                e.preventDefault(); const prevTd = td.previousElementSibling;
                                if(prevTd) { prevTd.focus(); setCaretPosition(prevTd, prevTd.textContent.length); }
                            } else if (e.key === 'ArrowDown' && isCaretAtEnd(td)) {
                                const nextTr = tr.nextElementSibling;
                                if(nextTr && nextTr.children[cIdx]) { e.preventDefault(); nextTr.children[cIdx].focus(); setCaretPosition(nextTr.children[cIdx], 0); }
                            } else if (e.key === 'ArrowUp' && isCaretAtStart(td)) {
                                const prevTr = tr.previousElementSibling;
                                if(prevTr && prevTr.children[cIdx]) { e.preventDefault(); prevTr.children[cIdx].focus(); setCaretPosition(prevTr.children[cIdx], prevTr.children[cIdx].textContent.length); }
                            } else if (e.key === 'Enter') {
                                // Shift+Enter（またはEnter）でセル内改行
                                e.preventDefault(); document.execCommand('insertLineBreak'); saveEditorState(true);
                            }
                        });
                        tr.appendChild(td);
                    });
                    table.appendChild(tr);
                });

                const addRowUp = document.createElement('button'); addRowUp.textContent = '+ 上に行';
                addRowUp.onclick = () => { 
                    syncData();
                    const newRow = new Array(data.rows[0].length).fill('');
                    data.rows.splice(activeCell.r, 0, newRow);
                    activeCell.r = Math.min(activeCell.r + 1, data.rows.length - 1); // 挿入分アクティブセルをずらす
                    renderTable(data); saveEditorState(true); 
                };

                // ▼新規追加：左に列
                const addColLeft = document.createElement('button'); addColLeft.textContent = '+ 左に列';
                addColLeft.onclick = () => { 
                    syncData();
                    data.rows.forEach(r => r.splice(activeCell.c, 0, '')); 
                    data.widths.splice(activeCell.c, 0, '');
                    activeCell.c = Math.min(activeCell.c + 1, data.rows[0].length - 1); // 挿入分アクティブセルをずらす
                    renderTable(data); saveEditorState(true); 
                };

                // マウスドラッグでの列幅リサイズ機能
                table.addEventListener('mousemove', (e) => {
                    if (e.target.tagName === 'TD') {
                        const rect = e.target.getBoundingClientRect();
                        if (e.clientX > rect.right - 8) e.target.style.cursor = 'col-resize';
                        else e.target.style.cursor = 'text';
                    }
                });
                
                table.addEventListener('mousedown', (e) => {
                    if (e.target.tagName === 'TD') {
                        const rect = e.target.getBoundingClientRect();
                        if (e.clientX > rect.right - 8) {
                            e.preventDefault();
                            const resizingTd = e.target;
                            const startX = e.clientX;
                            const startWidth = rect.width;
                            const cellIndex = resizingTd.cellIndex;
                            const firstRowTd = table.rows[0].cells[cellIndex];
                            
                            const onMouseMove = (moveEvt) => {
                                const newWidth = Math.max(30, startWidth + (moveEvt.clientX - startX));
                                if (firstRowTd) firstRowTd.style.width = `${newWidth}px`;
                            };
                            const onMouseUp = () => {
                                document.removeEventListener('mousemove', onMouseMove);
                                document.removeEventListener('mouseup', onMouseUp);
                                saveEditorState();
                            };
                            document.addEventListener('mousemove', onMouseMove);
                            document.addEventListener('mouseup', onMouseUp);
                        }
                    }
                });

                // ★修正3: 「フォーカスしているセル」を基準に行・列を追加/削除する
                const controls = document.createElement('div');
                controls.className = 'table-controls';
                controls.contentEditable = "false";
                
                const syncData = () => {
                    Array.from(table.rows).forEach((tr, rIdx) => {
                        Array.from(tr.cells).forEach((td, cIdx) => {
                            data.rows[rIdx][cIdx] = td.innerHTML;
                            if (rIdx === 0) data.widths[cIdx] = td.style.width || '';
                        });
                    });
                };

                const addRow = document.createElement('button'); addRow.textContent = '+ 下に行';
                addRow.onclick = () => { 
                    syncData();
                    const newRow = new Array(data.rows[0].length).fill('');
                    data.rows.splice(activeCell.r + 1, 0, newRow);
                    renderTable(data); saveEditorState(true); 
                };
                
                const addCol = document.createElement('button'); addCol.textContent = '+ 右に列';
                addCol.onclick = () => { 
                    syncData();
                    data.rows.forEach(r => r.splice(activeCell.c + 1, 0, '')); 
                    data.widths.splice(activeCell.c + 1, 0, '');
                    renderTable(data); saveEditorState(true); 
                };
                
                const delRow = document.createElement('button'); delRow.textContent = '→ 行を削除';
                delRow.onclick = () => { 
                    syncData();
                    if(data.rows.length > 1) { 
                        data.rows.splice(activeCell.r, 1); 
                        activeCell.r = Math.min(activeCell.r, data.rows.length - 1);
                        renderTable(data); saveEditorState(true); 
                    } 
                };
                
                const delCol = document.createElement('button'); delCol.textContent = '↓ 列を削除';
                delCol.onclick = () => { 
                    syncData();
                    if(data.rows[0].length > 1) { 
                        data.rows.forEach(r => r.splice(activeCell.c, 1)); 
                        data.widths.splice(activeCell.c, 1);
                        activeCell.c = Math.min(activeCell.c, data.rows[0].length - 1);
                        renderTable(data); saveEditorState(true); 
                    } 
                };
                
                controls.append(addRowUp, addRow, addColLeft, addCol, delRow, delCol);
                content.append(table, controls);
                
                // 再描画後に元のセルへフォーカスを戻す
                setTimeout(() => {
                    if (content.contains(table)) {
                        const targetRow = table.rows[activeCell.r];
                        if (targetRow && targetRow.cells[activeCell.c]) {
                            targetRow.cells[activeCell.c].focus();
                        }
                    }
                }, 10);
            };
            
            renderTable(tData);
            content.addEventListener('keydown', handleNonTextKeydown);
        } else {
            content.contentEditable = "true"; 
            content.innerHTML = blockData.content || '';
            content.addEventListener('keydown', handleBlockKeydown); 
            content.addEventListener('input', handleBlockInput); 
            content.addEventListener('paste', handleBlockPaste);
        }
        main.appendChild(content); 
        wrapper.appendChild(main);
        
        const childrenContainer = document.createElement('div'); 
        childrenContainer.className = 'block-children';
        if (blockData.children && Array.isArray(blockData.children) && blockData.children.length > 0) {
            renderBlocks(blockData.children, childrenContainer);
        }
        wrapper.appendChild(childrenContainer); 
        container.appendChild(wrapper);
    });
}

function handleNonTextKeydown(e) {
    const wrapper = e.target.closest('.block-wrapper');
    if (!wrapper) return;
    const contentEl = wrapper.querySelector('.block-content');

    if (e.key === 'Backspace' || e.key === 'Delete') { 
        e.preventDefault(); 
        const prev = wrapper.previousElementSibling; 

        if (wrapper.dataset.type === 'image') {
            const imgEl = wrapper.querySelector('img');
            const fileId = contentEl?.dataset.fileId;
            const imgUrl = imgEl ? imgEl.src : null;
            if (imgUrl || fileId) {
                deleteImageFromStorage(imgUrl, fileId);
            }
        }
        
        wrapper.remove(); 
        saveEditorState(true); 
        if (prev) { 
            const pc = prev.querySelector('.block-content'); 
            if (pc) { 
                pc.focus(); 
                if (pc.contentEditable === "true") setCaretPosition(pc, pc.textContent.length); 
            } 
        }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault(); 
        const prev = wrapper.previousElementSibling;
        if (prev && prev.classList.contains('block-wrapper')) { 
            const pc = prev.querySelector('.block-content'); 
            if (pc) {
                pc.focus(); 
                if (pc.contentEditable === "true") setCaretPosition(pc, pc.textContent.length); 
            }
        } else {
            pageTitleEl.focus();
        }
    } else if (e.key === 'Enter') {
        e.preventDefault();
        const tempContainer = document.createElement('div');
        const newId = generateId();
        renderBlocks([{ id: newId, type: 'p', content: '', children: [] }], tempContainer);
        const newBlock = tempContainer.firstElementChild;
        wrapper.after(newBlock);
        
        const nc = newBlock.querySelector('.block-content');
        if (nc) nc.focus();
        
        saveEditorState(true);
        reinitSortables();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        e.preventDefault(); 
        const next = wrapper.nextElementSibling;
        if (next && next.classList.contains('block-wrapper')) { 
            const nc = next.querySelector('.block-content'); 
            if (nc) {
                nc.focus(); 
                if (nc.contentEditable === "true") setCaretPosition(nc, 0); 
            }
        }
    }
}

function reinitSortables() {
    sortableInstances.forEach(s => s.destroy()); 
    sortableInstances = [];
    
    const initS = (el) => sortableInstances.push(new Sortable(el, { 
        group: 'shared', 
        handle: '.drag-handle', 
        animation: 150, 
        fallbackOnBody: true,
        fallbackTolerance: 3,
        onStart: () => { window.isDraggingBlock = true; }, 
        onEnd: () => { 
            setTimeout(() => { window.isDraggingBlock = false; }, 100); 
            saveEditorState(true); 
        } 
    }));
    
    if(editorEl) initS(editorEl); 
    document.querySelectorAll('#editor .block-children').forEach(el => initS(el));
}

function extractBlocks(container) {
    if(!container) return [];
    return Array.from(container.children).filter(el => el.classList.contains('block-wrapper')).map(wrapper => {
        const type = wrapper.dataset.type;
        const contentEl = wrapper.querySelector(':scope > .block-main > .block-content');
        const fileId = contentEl?.dataset.fileId || null;

        let content = '';
        if (type === 'page_link') content = contentEl?.dataset.linkId || '';
        else if (type === 'image') content = contentEl?.querySelector('img')?.src || '';
else if (type === 'table') {
            const rows = [];
            const widths = [];
            wrapper.querySelectorAll('.motion-table tr').forEach((tr, rIdx) => {
                const r = [];
                tr.querySelectorAll('td').forEach((td, cIdx) => {
                    r.push(DOMPurify.sanitize(td.innerHTML, { ALLOWED_TAGS: ['br','b','i','u','s','span'] }));
                    if (rIdx === 0) widths.push(td.style.width || '');
                });
                rows.push(r);
            });
            content = JSON.stringify({ widths, rows });
        } else if (contentEl) {
            content = DOMPurify.sanitize(contentEl.innerHTML, { ALLOWED_TAGS: ['a','br','b','strong','i','em','u','s','strike','span'], ALLOWED_ATTR: ['href','target','rel','style','class'] });
        }
        return { 
            id: wrapper.dataset.id, 
            type, 
            content, 
            fileId, 
            checked: wrapper.classList.contains('checked'), 
            toggleOpen: wrapper.classList.contains('open'), 
            children: extractBlocks(wrapper.querySelector(':scope > .block-children')) 
        };
    });
}

let saveDebounceTimer = null;
function saveEditorState(isStructuralChange = false) {
    if (!state.currentPageId || !editorEl) return;
    const page = state.pages[state.currentPageId];
    const executeSave = async () => {
        page.blocks = extractBlocks(editorEl);
        if(isStructuralChange) pushHistory(state.currentPageId);
        await saveData();
    };
    if (isStructuralChange) { clearTimeout(saveDebounceTimer); executeSave(); }
    else { 
        clearTimeout(saveDebounceTimer); 
        saveDebounceTimer = setTimeout(executeSave, 200); 
    }
}

function setCaretPosition(el, pos) {
    const range = document.createRange(); const sel = window.getSelection();
    let charIndex = 0, nodeStack = [el], node, found = false;
    if(pos === 0) { range.setStart(el, 0); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); return; }
    while (!found && (node = nodeStack.pop())) {
        if (node.nodeType === 3) {
            const nextCharIndex = charIndex + node.length;
            if (pos <= nextCharIndex) { range.setStart(node, pos - charIndex); found = true; }
            charIndex = nextCharIndex;
        } else {
            let i = node.childNodes.length; while (i--) nodeStack.push(node.childNodes[i]);
        }
    }
    range.collapse(true); sel.removeAllRanges(); sel.addRange(range);
}

function insertNodeAtCaret(node) {
    const sel = window.getSelection(); if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0); range.deleteContents();
    const lastNode = node.nodeType === 11 ? node.lastChild : node;
    range.insertNode(node);
    if (lastNode) { range.setStartAfter(lastNode); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); }
}

function getVisibleContents() { 
    return Array.from(document.querySelectorAll('#editor .block-content')).filter(el => el.getBoundingClientRect().height > 0); 
}

const slashMenuEl = document.getElementById('slash-menu');
let slashQuery = null, slashTargetBlock = null;

// ================= ブロック境界の正確な判定関数 =================
function isCaretAtStart(el) {
    const sel = window.getSelection(); if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0); const preRange = document.createRange();
    preRange.selectNodeContents(el); preRange.setEnd(range.startContainer, range.startOffset);
    const tmp = document.createElement('div'); tmp.appendChild(preRange.cloneContents());
    return tmp.textContent.length === 0 && tmp.querySelector('img, br') === null;
}

function isCaretAtEnd(el) {
    const sel = window.getSelection(); if (!sel.rangeCount) return false;
    const range = sel.getRangeAt(0); const postRange = document.createRange();
    postRange.selectNodeContents(el); postRange.setStart(range.endContainer, range.endOffset);
    const tmp = document.createElement('div'); tmp.appendChild(postRange.cloneContents());
    return tmp.textContent.length === 0 && tmp.querySelector('img, br') === null;
}

function isBlockEmpty(el) {
    return el.textContent.length === 0 && el.querySelector('img') === null;
}

function handleBlockKeydown(e) {
    if (e.isComposing) return;
    
    if (slashMenuEl && !slashMenuEl.classList.contains('hidden')) {
        if (e.key === 'ArrowUp') { e.preventDefault(); navigateSlashMenu(-1); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); navigateSlashMenu(1); return; }
        if (e.key === 'Enter') { e.preventDefault(); const selected = slashMenuEl.querySelector('.selected'); if(selected) selected.click(); return; }
    }

    const contentEl = e.target; const wrapper = contentEl.closest('.block-wrapper');
    
    const isCollapsed = window.getSelection().isCollapsed;
    const empty = isBlockEmpty(contentEl);
    const atStart = empty || isCaretAtStart(contentEl);
    const atEnd = empty || isCaretAtEnd(contentEl);

    if (e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown' || e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        const allContents = getVisibleContents();
        const idx = allContents.indexOf(contentEl);
        let targetIdx = -1;

        if ((e.key === 'ArrowUp' || e.key === 'ArrowLeft') && atStart && idx > 0) {
            targetIdx = idx - 1;
        } else if ((e.key === 'ArrowDown' || e.key === 'ArrowRight') && atEnd && idx < allContents.length - 1) {
            targetIdx = idx + 1;
        }

        if (targetIdx !== -1) {
            e.preventDefault();
            const currentBlock = wrapper;
            const targetBlock = allContents[targetIdx].closest('.block-wrapper');
            const blocks = getFlatBlockElements();
            
            blockSelectionStartIdx = blocks.indexOf(currentBlock);
            
            window.getSelection().removeAllRanges();
            clearBlockSelection(false);
            
            currentBlock.classList.add('selected-block');
            selectedBlocks.add(currentBlock.dataset.id);
            targetBlock.classList.add('selected-block');
            selectedBlocks.add(targetBlock.dataset.id);
            return;
        }
    }

    if (e.key === 'Tab') {
        e.preventDefault();
        if (e.shiftKey) {
            const parentChildren = wrapper.parentElement;
            if (parentChildren.classList.contains('block-children')) {
                parentChildren.closest('.block-wrapper').after(wrapper);
                contentEl.focus(); saveEditorState(true); reinitSortables();
            }
        } else {
            const prev = wrapper.previousElementSibling;
            if (prev && prev.classList.contains('block-wrapper') && prev.dataset.type !== 'page_link' && prev.dataset.type !== 'image') {
                prev.querySelector(':scope > .block-children').appendChild(wrapper);
                if (prev.dataset.type === 'toggle') prev.classList.add('open');
                contentEl.focus(); saveEditorState(true); reinitSortables();
            }
        }
        return;
    }

    if (e.key === 'Enter') {
        if (e.shiftKey) { 
            e.preventDefault(); 
            document.execCommand('insertLineBreak'); 
            saveEditorState(true); 
            return; 
        }
        e.preventDefault();
        
        const isEmpty = contentEl.textContent.trim() === '';

        if (isEmpty && wrapper.dataset.type !== 'p') {
            wrapper.dataset.type = 'p';
            const mainEl = wrapper.querySelector(':scope > .block-main');
            
            mainEl?.querySelector('.todo-checkbox')?.remove();
            mainEl?.querySelector('.toggle-icon')?.remove();
            wrapper.classList.remove('checked', 'open');
            
            saveEditorState(true);
            return;
        }

        if (isEmpty) {
            const parentChildren = wrapper.parentElement;
            if (parentChildren && parentChildren.classList.contains('block-children')) {
                const parentWrapper = parentChildren.closest('.block-wrapper');
                if (parentWrapper) {
                    parentWrapper.after(wrapper);
                    contentEl.focus();
                    saveEditorState(true);
                    reinitSortables();
                    return;
                }
            }
        }

        const range = window.getSelection().getRangeAt(0);
        const preRange = document.createRange(); preRange.selectNodeContents(contentEl); preRange.setEnd(range.startContainer, range.startOffset);
        const postRange = document.createRange(); postRange.selectNodeContents(contentEl); postRange.setStart(range.endContainer, range.endOffset);
        
        const div1 = document.createElement('div'); div1.appendChild(preRange.cloneContents());
        const div2 = document.createElement('div'); div2.appendChild(postRange.cloneContents());
        
        contentEl.innerHTML = div1.innerHTML;
        const tempContainer = document.createElement('div');
        renderBlocks([{ id: generateId(), type: wrapper.dataset.type === 'todo' ? 'todo' : 'p', content: div2.innerHTML, children: [] }], tempContainer);
        const newEl = tempContainer.firstElementChild;
        
        if (wrapper.dataset.type === 'toggle' && wrapper.classList.contains('open')) {
            wrapper.querySelector(':scope > .block-children').prepend(newEl);
        } else { wrapper.after(newEl); }
        newEl.querySelector('.block-content').focus();
        saveEditorState(true); reinitSortables();
    } 
    else if (e.key === 'Backspace' && isCollapsed && atStart) {
        e.preventDefault();
        
        if (wrapper.dataset.type !== 'p' && wrapper.dataset.type !== 'page_link' && wrapper.dataset.type !== 'image') {
            wrapper.dataset.type = 'p';
            const mainEl = wrapper.querySelector(':scope > .block-main');
            
            mainEl?.querySelector('.todo-checkbox')?.remove();
            mainEl?.querySelector('.toggle-icon')?.remove();
            wrapper.classList.remove('checked', 'open');
            
            saveEditorState(true);
            return;
        }

        const allContents = getVisibleContents(); const idx = allContents.indexOf(contentEl);
        if (idx > 0) {
            const prevContent = allContents[idx - 1]; const prevWrapper = prevContent.closest('.block-wrapper');
            if (prevWrapper.dataset.type !== 'page_link' && prevWrapper.dataset.type !== 'image') {
                const prevLen = prevContent.textContent.length;
                if (contentEl.innerHTML !== '') prevContent.innerHTML += contentEl.innerHTML; 
                const myChildren = wrapper.querySelector(':scope > .block-children');
                if (myChildren) while(myChildren.firstChild) wrapper.after(myChildren.firstChild);
                wrapper.remove(); prevContent.focus(); setCaretPosition(prevContent, prevLen);
                saveEditorState(true); closeSlashMenu();
            } else {
                if (prevWrapper.dataset.type === 'image') {
                    const imgEl = prevWrapper.querySelector('img');
                    const fileId = prevWrapper.querySelector('.block-content')?.dataset.fileId;
                    deleteImageFromStorage(imgEl?.src, fileId);
                }
                prevWrapper.remove(); 
                saveEditorState(true); 
            }
        }
    }
    else if (e.key === 'Delete' && isCollapsed && atEnd) {
        e.preventDefault();
        const currentLen = contentEl.textContent.length;
        const allContents = getVisibleContents(); const idx = allContents.indexOf(contentEl);
        if (idx < allContents.length - 1) {
            const nextContent = allContents[idx + 1]; const nextWrapper = nextContent.closest('.block-wrapper');
            if (nextWrapper.dataset.type !== 'page_link' && nextWrapper.dataset.type !== 'image') {
                if (nextContent.innerHTML !== '') contentEl.innerHTML += nextContent.innerHTML;
                const nextChildren = nextWrapper.querySelector(':scope > .block-children');
                if (nextChildren) while(nextChildren.firstChild) nextWrapper.after(nextChildren.firstChild);
                nextWrapper.remove(); setCaretPosition(contentEl, currentLen);
                saveEditorState(true); closeSlashMenu();
            } else {
                if (nextWrapper.dataset.type === 'image') {
                    const imgEl = nextWrapper.querySelector('img');
                    const fileId = nextWrapper.querySelector('.block-content')?.dataset.fileId;
                    deleteImageFromStorage(imgEl?.src, fileId);
                }
                nextWrapper.remove(); 
                saveEditorState(true); 
            }
        }
    }
    else if (e.key === 'ArrowUp') {
        if (atStart) {
            const allContents = getVisibleContents(); 
            const idx = allContents.indexOf(contentEl);
            if (idx > 0) {
                e.preventDefault(); 
                const prev = allContents[idx - 1]; 
                prev.focus(); 
                if (prev.contentEditable === "true") setCaretPosition(prev, prev.textContent.length);
            } else if (idx === 0) {
                e.preventDefault();
                pageTitleEl.focus();
            }
        }
    }
    else if (e.key === 'ArrowDown') {
        if (atEnd) {
            const allContents = getVisibleContents(); 
            const idx = allContents.indexOf(contentEl);
            if (idx < allContents.length - 1) {
                e.preventDefault(); 
                const next = allContents[idx + 1]; 
                next.focus(); 
                if (next.contentEditable === "true") setCaretPosition(next, 0);
            }
        }
    }
}

function handleBlockPaste(e) {
    const clipboardData = e.clipboardData || window.clipboardData;
    
    const motionData = clipboardData.getData('application/x-motion-blocks');
    if (motionData) {
        e.preventDefault();
        try {
            const blocksData = JSON.parse(motionData);
            const newBlocks = regenerateBlockIds(blocksData);
            
            const targetWrapper = e.target.closest('.block-wrapper');
            if (targetWrapper) {
                const tempContainer = document.createElement('div');
                renderBlocks(newBlocks, tempContainer);
                
                const fragment = document.createDocumentFragment();
                while(tempContainer.firstChild) {
                    fragment.appendChild(tempContainer.firstChild);
                }
                
                const contentEl = targetWrapper.querySelector('.block-content');
                if (targetWrapper.dataset.type === 'p' && contentEl && contentEl.textContent.trim() === '') {
                    targetWrapper.replaceWith(fragment);
                } else {
                    targetWrapper.after(fragment);
                }
                
                saveEditorState(true);
                reinitSortables();
                return;
            }
        } catch(err) {
            console.error("Structured paste error", err);
        }
    }

    const items = clipboardData.items;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
            e.preventDefault();
            const file = items[i].getAsFile();
            const wrapper = e.target.closest('.block-wrapper');
            if (file && wrapper) uploadAndInsertImage(file, wrapper);
            return;
        }
    }

    e.preventDefault();
    const pastedText = clipboardData.getData('text/plain');
    const sel = window.getSelection();
    const isUrl = /^https?:\/\//i.test(pastedText.trim());

    if (!sel.isCollapsed && isUrl) {
        const a = document.createElement('a');
        a.href = pastedText.trim(); a.target = "_blank"; a.rel = "noopener noreferrer"; a.textContent = sel.toString();
        insertNodeAtCaret(a);
    } else {
        document.execCommand('insertText', false, pastedText);
    }
    saveEditorState(true);
}

document.addEventListener('click', (e) => {
    const a = e.target.closest('a');
    if (a && a.href) window.open(a.href, '_blank', 'noopener,noreferrer');
});

// ================= スラッシュコマンド =================
function handleBlockInput(e) {
    const text = e.target.textContent; const wrapper = e.target.closest('.block-wrapper');
    const mdMatch = text.match(/^(#{1,3}|\[\]|>)( |\u00A0)$/);
    if (mdMatch && wrapper.dataset.type === 'p') {
        let matchedType = null;
        if (mdMatch[1] === '#') matchedType = 'h1'; else if (mdMatch[1] === '##') matchedType = 'h2'; else if (mdMatch[1] === '###') matchedType = 'h3';
        else if (mdMatch[1] === '[]') matchedType = 'todo'; else if (mdMatch[1] === '>') matchedType = 'toggle';
        
        if (matchedType) {
            const temp = document.createElement('div');
            const extracted = { id: wrapper.dataset.id, type: matchedType, content: '', children: [] };
            if (matchedType === 'toggle') { extracted.toggleOpen = true; extracted.children = [{id: generateId(), type: 'p', content: '', children: []}]; }
            renderBlocks([extracted], temp);
            const newEl = temp.firstElementChild;
            wrapper.replaceWith(newEl); newEl.querySelector(':scope > .block-main > .block-content').focus();
            saveEditorState(true); reinitSortables(); closeSlashMenu(); return;
        }
    }

    const match = text.match(/(^|\s)\/([^\/]*)$/);
    if (match) { slashQuery = match[2].toLowerCase(); slashTargetBlock = wrapper; showSlashMenu(e.target); }
    else { closeSlashMenu(); }
    saveEditorState(); 
}

function showSlashMenu(el) {
    if(!slashMenuEl) return;
    slashMenuEl.innerHTML = '';
    const filtered = COMMANDS.filter(cmd => !slashQuery || cmd.keys.some(k => k.toLowerCase().includes(slashQuery)));
    if (filtered.length === 0) { closeSlashMenu(); return; }
    
    filtered.forEach((cmd, i) => {
        const div = document.createElement('div'); div.className = `slash-item ${i===0?'selected':''}`;
        div.innerHTML = `<div style="font-weight:500;">${cmd.label}</div><div style="font-size:12px;color:gray;">${cmd.desc}</div>`;
        div.onclick = () => executeCommand(cmd.id); slashMenuEl.appendChild(div);
    });
    const rect = el.getBoundingClientRect(); 
    slashMenuEl.style.top = `${rect.bottom + window.scrollY}px`; slashMenuEl.style.left = `${rect.left + window.scrollX}px`; 
    slashMenuEl.classList.remove('hidden');
}

function navigateSlashMenu(dir) {
    if(!slashMenuEl) return; const items = Array.from(slashMenuEl.children); if(items.length === 0) return;
    let idx = items.findIndex(i => i.classList.contains('selected'));
    if(idx !== -1) items[idx].classList.remove('selected');
    idx = (idx + dir + items.length) % items.length;
    items[idx].classList.add('selected');
}
function closeSlashMenu() { slashMenuEl?.classList.add('hidden'); slashQuery = null; slashTargetBlock = null; }

let savedCaretRange = null, pendingExtLinkBlock = null;

function executeCommand(cmdId) {
    if (!slashTargetBlock) return;
    const targetBlock = slashTargetBlock; const contentEl = targetBlock.querySelector('.block-content');
    contentEl.textContent = contentEl.textContent.substring(0, contentEl.textContent.lastIndexOf('/'));
    contentEl.focus(); setCaretPosition(contentEl, contentEl.textContent.length);
    savedCaretRange = window.getSelection().getRangeAt(0).cloneRange();
    closeSlashMenu();

    if (cmdId === 'image') {
        pendingImageTargetBlock = targetBlock;
        document.getElementById('image-upload-input').click();
    } else if (cmdId === 'link') {
        pendingExtLinkBlock = targetBlock; 
        document.getElementById('ext-link-title').value = ''; document.getElementById('ext-link-url').value = '';
        document.getElementById('ext-link-overlay').classList.remove('hidden');
        setTimeout(() => document.getElementById('ext-link-url').focus(), 10);
    } else if (cmdId === 'linkpage') {
        const linkSelect = document.getElementById('link-select');
        linkSelect.innerHTML = '';
        Object.values(state.pages).forEach(p => {
            if(p.id !== state.currentPageId) { 
                const opt = document.createElement('option');
                opt.value = p.id; opt.textContent = p.title || '無題'; linkSelect.appendChild(opt);
            }
        });
        document.getElementById('link-overlay').classList.remove('hidden');
        pendingExtLinkBlock = targetBlock;
    } else if (cmdId === 'page') {
        const childId = generateId();
        const childPage = { 
            id: childId, 
            title: '', 
            parentId: state.currentPageId, 
            blocks: [{ id: generateId(), type: 'p', content: '', children:[] }], 
            isLocked: false 
        };
        state.pages[childId] = childPage;

        (async () => {
            await createPageInAppwrite(childPage);
            const temp = document.createElement('div'); 
            renderBlocks([{id: targetBlock.dataset.id, type: 'page_link', content: childId, children:[]}], temp);
            targetBlock.replaceWith(temp.firstElementChild);
            saveEditorState(true); 
            renderTree(); 
            openPage(childId); 
            setTimeout(() => pageTitleEl.focus(), 10);
        })();
    } else {
        const temp = document.createElement('div'); 
        const extracted = { id: targetBlock.dataset.id, type: cmdId, content: contentEl.innerHTML, children:[] };
        if (cmdId === 'toggle') { extracted.toggleOpen = true; extracted.children = [{id: generateId(), type: 'p', content: '', children: []}]; }
        renderBlocks([extracted], temp);
        const newEl = temp.firstElementChild;
        targetBlock.replaceWith(newEl); newEl.querySelector(':scope > .block-main > .block-content').focus();
        saveEditorState(true); reinitSortables();
    }
}

// ================= ブロックオプションメニュー =================
let blockMenuTarget = null;
const blockMenuEl = document.getElementById('block-menu');

function showBlockMenu(e, handleEl) {
    e.stopPropagation();
    e.preventDefault();
    blockMenuTarget = handleEl.closest('.block-wrapper');
    if (!blockMenuTarget || !blockMenuEl) return;

   
    blockMenuEl.classList.remove('hidden');

    const rect = handleEl.getBoundingClientRect();
    const menuRect = blockMenuEl.getBoundingClientRect();

    let top = rect.bottom + window.scrollY;
    let left = rect.left + window.scrollX;

    if (rect.bottom + menuRect.height > window.innerHeight) {
        top = rect.top + window.scrollY - menuRect.height;
    }

    if (left + menuRect.width > window.innerWidth + window.scrollX) {
        left = window.innerWidth + window.scrollX - menuRect.width - 10;
    }

    if (top < window.scrollY) {
        top = window.scrollY + 10;
    }

    blockMenuEl.style.top = `${top}px`;
    blockMenuEl.style.left = `${left}px`;
}

function executeBlockMenu(action) {
    if (!blockMenuTarget) return;
    const contentEl = blockMenuTarget.querySelector('.block-content');
    
    if (action === 'delete') {
        if (blockMenuTarget.dataset.type === 'image') {
            const imgEl = blockMenuTarget.querySelector('img');
            const fileId = contentEl?.dataset.fileId;
            deleteImageFromStorage(imgEl?.src, fileId);
        }
        blockMenuTarget.remove();
        saveEditorState(true);
    } else if (action === 'copy') {
        const textToCopy = contentEl ? contentEl.innerText : '';
        navigator.clipboard.writeText(textToCopy);
    } else if (action === 'duplicate') {
        const cloned = blockMenuTarget.cloneNode(true);
        cloned.dataset.id = generateId();
        blockMenuTarget.after(cloned);
        saveEditorState(true);
        reinitSortables();
    } else {
        const temp = document.createElement('div');
        const extracted = { id: blockMenuTarget.dataset.id, type: action, content: contentEl ? contentEl.innerHTML : '', children: [] };
        
        if (action === 'toggle') {
            extracted.toggleOpen = true; 
            extracted.children = [{id: generateId(), type: 'p', content: '', children: []}];
        }
        const currentChildren = extractBlocks(blockMenuTarget.querySelector(':scope > .block-children'));
        if (currentChildren.length > 0) extracted.children = currentChildren;

        renderBlocks([extracted], temp);
        const newEl = temp.firstElementChild;
        blockMenuTarget.replaceWith(newEl);
        
        const newContent = newEl.querySelector(':scope > .block-main > .block-content');
        if (newContent) newContent.focus();
        
        saveEditorState(true);
        reinitSortables();
    }
    
    blockMenuEl.classList.add('hidden');
    blockMenuTarget = null;
}

document.addEventListener('click', (e) => {
    if (e.target.closest('.drag-handle')) return;

    if (blockMenuEl && !blockMenuEl.classList.contains('hidden')) {
        if (!e.target.closest('#block-menu')) {
            blockMenuEl.classList.add('hidden');
        }
    }
});

document.getElementById('ext-link-cancel')?.addEventListener('click', () => {
    document.getElementById('ext-link-overlay').classList.add('hidden');
    if(pendingExtLinkBlock && savedCaretRange) {
        pendingExtLinkBlock.querySelector('.block-content')?.focus();
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedCaretRange);
    }
});
document.getElementById('ext-link-submit')?.addEventListener('click', () => {
    let title = document.getElementById('ext-link-title').value || 'Link';
    let url = document.getElementById('ext-link-url').value;
    if(!url) return;
    if (!url.startsWith('http://') && !url.startsWith('https://')) url = 'https://' + url;
    document.getElementById('ext-link-overlay').classList.add('hidden');
    if (pendingExtLinkBlock && savedCaretRange) {
        pendingExtLinkBlock.querySelector('.block-content')?.focus();
        const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(savedCaretRange);
        const aTag = document.createElement('a');
        aTag.href = url; aTag.target = "_blank"; aTag.rel = "noopener noreferrer"; aTag.textContent = title;
        insertNodeAtCaret(aTag); insertNodeAtCaret(document.createTextNode('\u00A0'));
        saveEditorState(true); pendingExtLinkBlock = null; 
    }
});
document.getElementById('link-cancel')?.addEventListener('click', () => {
    document.getElementById('link-overlay').classList.add('hidden');
    pendingExtLinkBlock?.querySelector('.block-content')?.focus();
});
document.getElementById('link-submit')?.addEventListener('click', () => {
    const selectedId = document.getElementById('link-select')?.value;
    if(selectedId && pendingExtLinkBlock) {
        const temp = document.createElement('div'); 
        renderBlocks([{id: pendingExtLinkBlock.dataset.id, type: 'page_link', content: selectedId, children:[]}], temp);
        pendingExtLinkBlock.replaceWith(temp.firstElementChild);
        saveEditorState(true); renderTree(); reinitSortables();
    }
    document.getElementById('link-overlay').classList.add('hidden');
});

// ================= 画像アップロード =================
document.getElementById('image-upload-input').addEventListener('change', async function(e) {
    const file = e.target.files[0]; 
    const target = pendingImageTargetBlock || slashTargetBlock;
    if(!file || !target) return;
    
    await uploadAndInsertImage(file, target);
    this.value = '';
    pendingImageTargetBlock = null;
});

async function uploadAndInsertImage(file, targetBlock) {
    if (currentMediaBytes + file.size > MAX_MEDIA_BYTES) {
        alert("添付ファイルの上限 (500MB) を超過します。不要な画像を削除してください。");
        return;
    }

    const qualityMode = localStorage.getItem('motion_image_quality') || 'original';
    let fileToUpload = file;

    if (qualityMode === 'compressed') {
        fileToUpload = await compressImage(file, 1200, 0.7);
    }

    try {
        const safeName = `img_${Date.now()}_${Math.random().toString(36).substring(2, 7)}.jpg`;
        const uploadFile = new File([fileToUpload], safeName, { type: fileToUpload.type || 'image/jpeg' });

        const fileUploadRes = await storage.createFile(
            BUCKET_ID,
            ID.unique(),
            uploadFile,
            [
                Permission.read(Role.any()),
                Permission.update(Role.user(currentUser.$id)),
                Permission.delete(Role.user(currentUser.$id))
            ]
        );

        const fileUrl = storage.getFileView(BUCKET_ID, fileUploadRes.$id);

        const temp = document.createElement('div');
        renderBlocks([{ 
            id: targetBlock.dataset.id, 
            type: 'image', 
            content: fileUrl, 
            fileId: fileUploadRes.$id, 
            children:[] 
        }], temp);
        
        targetBlock.replaceWith(temp.firstElementChild);
        saveEditorState(true); 
        reinitSortables();
        calcStorageUsage();
    } catch (err) {
        alert("画像のアップロードに失敗しました: " + err.message);
        console.error(err);
    }
}

function compressImage(file, maxWidth, quality) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target.result;
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let width = img.width;
                let height = img.height;

                if (width > maxWidth) {
                    height = Math.round((height * maxWidth) / width);
                    width = maxWidth;
                }

                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    resolve(new File([blob], file.name || 'image.jpg', { type: 'image/jpeg', lastModified: Date.now() }));
                }, 'image/jpeg', quality);
            };
        };
    });
}

// ================= リッチテキスト Floating Menu =================
const floatMenu = document.getElementById('floating-menu');
document.addEventListener('selectionchange', () => {
    const sel = window.getSelection();
    if (!sel.isCollapsed && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (editorEl.contains(range.commonAncestorContainer)) {
            const rect = range.getBoundingClientRect();
            floatMenu.style.top = `${rect.top + window.scrollY - 40}px`;
            floatMenu.style.left = `${rect.left + window.scrollX + (rect.width/2) - (floatMenu.offsetWidth/2)}px`;
            floatMenu.classList.remove('hidden'); return;
        }
    }
    floatMenu.classList.add('hidden');
});

floatMenu.addEventListener('mousedown', (e) => {
    e.preventDefault(); 
    const btn = e.target.closest('button[data-cmd]');
    if (!btn) return;
    const cmd = btn.dataset.cmd, val = btn.dataset.val || null;
    document.execCommand(cmd, false, val);
    saveEditorState(); floatMenu.classList.add('hidden');
});

// ================= 全文検索・設定等のその他のUI =================
document.getElementById('search-btn').addEventListener('click', openSearchModal);
function openSearchModal() {
    const searchOverlay = document.getElementById('search-overlay'), searchInput = document.getElementById('search-input'), resultsEl = document.getElementById('search-results');
    searchOverlay.classList.remove('hidden'); searchInput.value = ''; resultsEl.innerHTML = ''; searchInput.focus();
    
    searchInput.oninput = (e) => {
        const q = e.target.value.toLowerCase(); resultsEl.innerHTML = '';
        if(!q) return;
        
        const includeLocked = localStorage.getItem('motion_search_locked') === 'true';
        
        Object.values(state.pages).forEach(p => {
            if (!includeLocked && isPageLocked(p.id)) return;
            
            let match = false; let snippet = '';
            
            if ((p.title||'無題').toLowerCase().includes(q)) match = true;
            else {
                const searchBlocks = (blocks) => {
                    for(let b of blocks) {
                        if(b.content && typeof b.content==='string' && b.type!=='image' && b.type!=='page_link') {
                            const text = b.content.replace(/<[^>]+>/g, '').toLowerCase();
                            if(text.includes(q)) { match = true; snippet = text.substring(Math.max(0, text.indexOf(q)-15), text.indexOf(q)+20) + '...'; return; }
                        }
                        if(b.children) searchBlocks(b.children);
                    }
                };
                if(Array.isArray(p.blocks)) searchBlocks(p.blocks);
            }
            if(match) {
                const div = document.createElement('div'); div.className = 'search-item';
                div.innerHTML = `<strong>${p.title||'無題'}</strong><br><span style="font-size:12px;color:var(--text-muted);">${snippet}</span>`;
                div.onclick = () => { searchOverlay.classList.add('hidden'); openPage(p.id); };
                resultsEl.appendChild(div);
            }
        });
    };
}
document.getElementById('settings-btn').addEventListener('click', () => document.getElementById('settings-overlay').classList.remove('hidden'));
document.getElementById('settings-close').addEventListener('click', () => document.getElementById('settings-overlay').classList.add('hidden'));

document.querySelectorAll('.settings-tab').forEach(tab => {
    tab.onclick = () => {
        document.querySelectorAll('.settings-tab').forEach(t => t.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
        tab.classList.add('active'); document.getElementById('tab-' + tab.dataset.tab).classList.remove('hidden');
    };
});


document.getElementById('btn-import')?.addEventListener('click', () => document.getElementById('file-import')?.click());
document.getElementById('file-import')?.addEventListener('change', async (e) => {
    const file = e.target.files[0]; if (!file) return;
    const reader = new FileReader();
    
    reader.onload = async (event) => {
        try {
            const imported = JSON.parse(event.target.result);
            if(imported && imported.pages) {
                alert("クラウドへのインポートを開始します。完了するまでブラウザを閉じないでください...");
                for (const key of Object.keys(imported.pages)) {
                    const page = imported.pages[key];
                    const existing = state.pages[page.id];
                    if (existing && existing.$id) {
                        page.$id = existing.$id; 
                        await saveDataToAppwrite(page);
                    } else {
                        await createPageInAppwrite(page);
                    }
                }
                const uiState = {
                    expandedNodes: imported.expandedNodes || [],
                    recentPages: imported.recentPages || []
                };
                localStorage.setItem('motion_ui_state', JSON.stringify(uiState));
                alert("復元が完了しました。ページを再読み込みします。");
                location.reload();
            }
        } catch (err) {
            alert("インポートに失敗しました: " + err.message);
            console.error(err);
        }
    };
    reader.readAsText(file);
});

document.getElementById('btn-reset')?.addEventListener('click', async () => {
    if(confirm("【警告】全データを消去します。\nこの操作はクラウド(Appwrite)上のあなたのデータも完全に削除します。よろしいですか？")) {
        try {
            if (currentUser) {
                const response = await databases.listDocuments(DB_ID, COLLECTION_PAGES);
                for (const doc of response.documents) {
                    await databases.deleteDocument(DB_ID, COLLECTION_PAGES, doc.$id);
                }
            }
            localStorage.clear(); 
            location.reload();
        } catch (err) {
            alert("リセット失敗: " + err.message);
        }
    }
});

document.getElementById('editor-bottom-padding')?.addEventListener('click', () => {
    if (state.currentPageId === 'home') return;
    const all = getVisibleContents();
    if(all.length > 0) {
        const last = all[all.length-1];
        if(last.textContent !== '') {
            const temp = document.createElement('div'); renderBlocks([{id: generateId(), type:'p', content:'', children:[]}], temp);
            editorEl.appendChild(temp.firstElementChild); getVisibleContents().pop().focus(); saveEditorState(true); reinitSortables();
        } else last.focus();
    }
});

document.getElementById('modal-pass')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('modal-submit')?.click(); }
});
document.getElementById('ext-link-url')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('ext-link-submit')?.click(); }
});
document.getElementById('ext-link-title')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('ext-link-submit')?.click(); }
});
document.getElementById('link-select')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('link-submit')?.click(); }
});
document.getElementById('search-input')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        const firstResult = document.querySelector('#search-results .search-item');
        if (firstResult) firstResult.click();
    }
});

// ================= 管理者・認証関連 =================
async function sendAdminRequestEmail(userEmail) {
    try {
        const serviceID = 'service_iwdudmi';
        const templateID = 'template_oba4fva';
        const publicKey = 'Rr8sXv8O4BghLKFMX';

        const templateParams = {
            admin_email: 'thonglo02cocoa@gmail.com',
            request_user_email: userEmail,
            message: `新規ユーザー (${userEmail}) からアカウント開設のリクエストがありました。管理画面から承認を行ってください。`
        };

        await emailjs.send(serviceID, templateID, templateParams, publicKey);
    } catch (err) {
        console.error('管理者へのメール送信に失敗しました:', err);
    }
}

async function approveAccount(targetUserId) {
    try {
        await databases.updateDocument(DB_ID, 'users', targetUserId, { status: 'approved' });
        alert('アカウントを承認しました。ユーザーはログイン可能になります。');
    } catch (err) {
        alert('承認エラー: ' + err.message);
    }
}

async function checkPendingUsersForAdmin() {
    try {
        const response = await databases.listDocuments(DB_ID, 'users', [
            Query.equal('status', 'pending')
        ]);

        if (response.documents.length > 0) {
            const count = response.documents.length;
            const emails = response.documents.map(doc => doc.email).join(', ');
            
            setTimeout(() => {
                if (confirm(`【管理者通知】\n現在、${count}件の新規アカウント承認待ちがあります。\n対象: ${emails}\n\n今すぐ設定画面から承認しますか？`)) {
                    document.getElementById('settings-overlay').classList.remove('hidden');
                    document.querySelector('.settings-tab[data-tab="admin"]')?.click();
                }
            }, 500);
        }
    } catch (err) {
        console.error('承認待ちユーザーの確認に失敗しました:', err);
    }
}

document.querySelector('.settings-tab[data-tab="admin"]')?.addEventListener('click', async () => {
    const listContainer = document.getElementById('admin-pending-users-list');
    if (!listContainer) return;
    
    listContainer.innerHTML = '<p style="font-size:13px; color:var(--text-muted);">読み込み中...</p>';

    try {
        const response = await databases.listDocuments(DB_ID, 'users', [
            Query.equal('status', 'pending')
        ]);

        if (response.documents.length === 0) {
            listContainer.innerHTML = '<p style="font-size:13px; color:var(--text-muted);">現在、承認待ちのユーザーはいません。</p>';
            return;
        }

        listContainer.innerHTML = '';
        response.documents.forEach(doc => {
            const item = document.createElement('div');
            item.style.cssText = 'display:flex; align-items:center; justify-content:space-between; padding:8px 12px; margin-bottom:8px; border:1px solid var(--border); border-radius:6px; background:var(--bg-hover);';
            
            item.innerHTML = `
                <div>
                    <div style="font-weight:500; font-size:14px;">${doc.email}</div>
                    <div style="font-size:11px; color:var(--text-muted);">申請日時: ${new Date(doc.$createdAt).toLocaleString()}</div>
                </div>
                <button class="primary-btn" style="padding:4px 12px; font-size:12px; width:auto;" data-id="${doc.$id}">承認する</button>
            `;

            item.querySelector('button').onclick = async () => {
                const btn = item.querySelector('button');
                btn.disabled = true;
                btn.textContent = '処理中...';
                
                try {
                    await databases.updateDocument(DB_ID, 'users', doc.$id, {
                        status: 'approved'
                    });
                    alert(`${doc.email} のアカウントを承認しました！`);
                    document.querySelector('.settings-tab[data-tab="admin"]').click();
                } catch (e) {
                    alert('承認エラー: ' + e.message);
                    btn.disabled = false;
                    btn.textContent = '承認する';
                }
            };

            listContainer.appendChild(item);
        });
    } catch (err) {
        listContainer.innerHTML = '<p style="font-size:13px; color:var(--danger);">リストの取得に失敗しました。</p>';
    }
});

document.addEventListener('click', (e) => {
    const btn = e.target.closest('.toggle-password-btn');
    if (!btn) return;

    const targetId = btn.getAttribute('data-target');
    const inputEl = document.getElementById(targetId);
    const iconUseEl = btn.querySelector('use');
    if (!inputEl) return;

    if (inputEl.style.webkitTextSecurity !== undefined && inputEl.style.webkitTextSecurity !== '') {
        if (inputEl.style.webkitTextSecurity === 'disc') {
            inputEl.style.webkitTextSecurity = 'none';
            iconUseEl.setAttribute('href', '#icon-eye-off');
            btn.title = 'パスワードを隠す';
        } else {
            inputEl.style.webkitTextSecurity = 'disc';
            iconUseEl.setAttribute('href', '#icon-eye');
            btn.title = 'パスワードを表示';
        }
    } else {
        if (inputEl.type === 'password') {
            inputEl.type = 'text';
            iconUseEl.setAttribute('href', '#icon-eye-off');
            btn.title = 'パスワードを隠す';
        } else {
            inputEl.type = 'password';
            iconUseEl.setAttribute('href', '#icon-eye');
            btn.title = 'パスワードを表示';
        }
    }
});

// ================= マウスドラッグでの複数選択機能 =================
document.addEventListener('mousedown', (e) => {
    if (!e.target.closest('#editor')) {
        clearBlockSelection();
        return;
    }
    const block = e.target.closest('.block-wrapper');
    if (block && !e.shiftKey) {
        if (selectedBlocks.size > 0) clearBlockSelection();
        blockSelectionStartIdx = getFlatBlockElements().indexOf(block);
        isBlockSelecting = true;
    }
});

document.addEventListener('mousemove', (e) => {
    if (!isBlockSelecting || blockSelectionStartIdx === -1) return;
    if ((e.buttons & 1) === 0) {
        isBlockSelecting = false;
        return;
    }

    const block = e.target.closest('.block-wrapper');
    if (block) {
        const blocks = getFlatBlockElements();
        const currentIdx = blocks.indexOf(block);
        
        if (currentIdx !== -1 && currentIdx !== blockSelectionStartIdx) {
            window.getSelection().removeAllRanges();
            
            const start = Math.min(blockSelectionStartIdx, currentIdx);
            const end = Math.max(blockSelectionStartIdx, currentIdx);
            
            clearBlockSelection(false); 
            for (let i = start; i <= end; i++) {
                blocks[i].classList.add('selected-block');
                selectedBlocks.add(blocks[i].dataset.id);
            }
        }
    }
});

document.addEventListener('mouseup', () => { isBlockSelecting = false; });

// ================= 構造化コピー＆カット =================
function handleClipboard(e, isCut) {
    if (selectedBlocks.size > 0) {
        e.preventDefault();
        const extracted = [];
        const blocks = getFlatBlockElements();
        
        blocks.forEach(b => {
            if (selectedBlocks.has(b.dataset.id)) {
                const parentWrapper = b.parentElement.closest('.block-wrapper');
                if (!parentWrapper || !selectedBlocks.has(parentWrapper.dataset.id)) {
                    extracted.push(extractSingleBlock(b));
                }
            }
        });

        const motionData = JSON.stringify(extracted);
        const markdownText = convertBlocksToMarkdown(extracted);

        e.clipboardData.setData('application/x-motion-blocks', motionData);
        e.clipboardData.setData('text/plain', markdownText);
        
        if (isCut) deleteSelectedBlocks();
    }
}
document.addEventListener('copy', (e) => handleClipboard(e, false));
document.addEventListener('cut', (e) => handleClipboard(e, true));

// ================= スワイプでのサイドバー開閉機能 =================
let touchStartX = 0;
let touchEndX = 0;

document.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
}, { passive: true });

document.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
}, { passive: true });

function handleSwipe() {
    const swipeThreshold = 50; // スワイプと判定する移動距離（px）
    const isMobile = window.innerWidth <= 768;
    
    // PC画面では何もしない
    if (!isMobile) return;

    // 右スワイプ（メニューを開く）
    if (touchEndX - touchStartX > swipeThreshold) {
        // 誤作動を防ぐため、画面の左端（50px以内）からのスワイプのみ反応させる
        if (touchStartX < 50) {
            sidebar.classList.add('open');
            sidebarOverlay.classList.add('active');
        }
    } 
    // 左スワイプ（メニューを閉じる）
    else if (touchStartX - touchEndX > swipeThreshold) {
        if (sidebar.classList.contains('open')) {
            sidebar.classList.remove('open');
            sidebarOverlay.classList.remove('active');
        }
    }
}

// ================= モバイルツールバー制御 (UI/UX最適化版) =================

let lastActiveContentEl = null;

// エディタ内のフォーカスを常に監視し、最後に触ったブロックを記憶
document.addEventListener('focusin', (e) => {
    if (e.target && e.target.classList && e.target.classList.contains('block-content')) {
        lastActiveContentEl = e.target;
    }
});

// ツールバーのボタン押下時にフォーカスが外れるのを防ぐ処理
document.querySelectorAll('.m-tool-btn').forEach(btn => {
    const handleToolbarTap = (e) => {
        // ★最重要: preventDefaultによりフォーカス喪失を防ぎ、キーボードを閉じさせない
        e.preventDefault(); 
        
        const action = btn.dataset.action;
        if (action === 'menu') {
            openMobileBottomSheet();
        } else {
            mobileToolbarCmd(action, action);
        }
    };
    // PC・スマホ両方のタッチ/クリックイベントで発火
    btn.addEventListener('mousedown', handleToolbarTap);
    btn.addEventListener('touchstart', handleToolbarTap, { passive: false });
});

function mobileToolbarCmd(action, type) {
    if (!lastActiveContentEl) return;
    const wrapper = lastActiveContentEl.closest('.block-wrapper');
    if (!wrapper) return;

    if (action === 'image') {
        pendingImageTargetBlock = wrapper;
        document.getElementById('image-upload-input').click();
    } else if (['bold', 'italic'].includes(action)) {
        // テキスト装飾
        document.execCommand(action, false, null);
        saveEditorState();
    } else {
        // ブロック変換処理
        const temp = document.createElement('div');
        const content = lastActiveContentEl.innerHTML || '';
        const extracted = { id: wrapper.dataset.id, type: type, content: content, children: [] };
        
        if (type === 'toggle') { 
            extracted.toggleOpen = true; 
            extracted.children = [{id: generateId(), type: 'p', content: '', children: []}]; 
        }

        renderBlocks([extracted], temp);
        const newEl = temp.firstElementChild;
        wrapper.replaceWith(newEl);
        
        // 変換後、新しいブロックに確実にフォーカスを戻してキーボードを維持する
        const newContent = newEl.querySelector('.block-content');
        if (newContent) {
            newContent.focus();
            if (newContent.contentEditable === "true") {
                setCaretPosition(newContent, newContent.textContent.length);
            }
        }
        
        saveEditorState(true);
        reinitSortables();
    }
}

// ================= iOS最適化: Visual Viewport API による追従 =================
if (window.visualViewport) {
    const updateViewportPos = () => {
        const vv = window.visualViewport;
        if (!vv || window.innerWidth > 1024) return;
        
        // 1. ツールバーの追従 (キーボード上端に配置)
        const tb = document.getElementById('mobile-toolbar');
        if (tb) {
            const topPos = vv.offsetTop + vv.height - 50; 
            tb.style.top = `${topPos > 0 ? topPos : 0}px`;
        }

        // 2. ボトムシートの追従 (キーボードを除いた表示領域にピッタリ合わせる)
        const sheetOverlay = document.getElementById('mobile-bottom-sheet-overlay');
        if (sheetOverlay) {
            // Visual Viewportの offsetTop(画面上部からのズレ) と height(見えている高さ) を適用
            sheetOverlay.style.top = `${vv.offsetTop}px`;
            sheetOverlay.style.height = `${vv.height}px`;
        }
    };

    window.visualViewport.addEventListener('resize', updateViewportPos);
    window.visualViewport.addEventListener('scroll', updateViewportPos);
    
    // 初期配置用
    setTimeout(updateViewportPos, 100);
}

// ================= ボトムシートメニュー (モバイル専用コマンドメニュー) =================
const sheetOverlay = document.getElementById('mobile-bottom-sheet-overlay');
const sheetContent = document.getElementById('mobile-sheet-content');

function openMobileBottomSheet() {
    if (!lastActiveContentEl || !sheetOverlay || !sheetContent) return;
    const wrapper = lastActiveContentEl.closest('.block-wrapper');
    if (!wrapper) return;
    
    slashTargetBlock = wrapper;
    
    // コマンド一覧を生成
    sheetContent.innerHTML = '';
    COMMANDS.forEach(cmd => {
        const item = document.createElement('div');
        item.className = 'sheet-item';
        item.innerHTML = `<div class="sheet-item-title">${cmd.label}</div><div class="sheet-item-desc">${cmd.desc}</div>`;
        
        let startX = 0;
        let startY = 0;
        let isSwiping = false;

        item.addEventListener('touchstart', (e) => {
            if (e.touches.length > 0) {
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                isSwiping = false;
            }
        }, { passive: true });

        item.addEventListener('touchmove', (e) => {
            if (e.touches.length > 0) {
                const moveX = Math.abs(e.touches[0].clientX - startX);
                const moveY = Math.abs(e.touches[0].clientY - startY);
                // 上下や左右に一定以上指を動かした場合は「スクロール操作」と判定
                if (moveX > 8 || moveY > 8) {
                    isSwiping = true;
                }
            }
        }, { passive: true });

        const handleItemTap = (e) => {
            // スワイプ（スクロール）中の場合は機能を実行しない
            if (isSwiping) return;

            e.preventDefault(); // フォーカス外れ防止
            closeMobileBottomSheet();
            executeMobileCommand(cmd.id);
        };
        
        item.addEventListener('mousedown', handleItemTap);
        item.addEventListener('touchend', (e) => {
            if (!isSwiping) {
                handleItemTap(e);
            }
        });

        sheetContent.appendChild(item);
    });
    
    sheetOverlay.classList.remove('hidden');
}

function closeMobileBottomSheet() {
    if (sheetOverlay) sheetOverlay.classList.add('hidden');
}

// 余白（暗転している背景）のタップで確実にキャンセルして閉じる
if (sheetOverlay) {
    sheetOverlay.addEventListener('mousedown', (e) => {
        if (e.target === sheetOverlay) {
            e.preventDefault();
            closeMobileBottomSheet();
        }
    });
    sheetOverlay.addEventListener('touchstart', (e) => {
        if (e.target === sheetOverlay) {
            e.preventDefault();
            closeMobileBottomSheet();
        }
    }, { passive: false });
}

const closeSheetBtn = document.getElementById('close-sheet-btn');
if (closeSheetBtn) {
    closeSheetBtn.addEventListener('click', closeMobileBottomSheet);
}

// モバイル専用のコマンド実行関数（PC版の `/` 削除ロジックに影響されないように分離）
function executeMobileCommand(cmdId) {
    if (!slashTargetBlock) return;
    const targetBlock = slashTargetBlock;
    const contentEl = targetBlock.querySelector('.block-content');
    
    contentEl.focus(); 
    setCaretPosition(contentEl, contentEl.textContent.length);
    
    // 範囲選択状態を保存
    const sel = window.getSelection();
    if (sel.rangeCount > 0) {
        savedCaretRange = sel.getRangeAt(0).cloneRange();
    }

    if (cmdId === 'image') {
        pendingImageTargetBlock = targetBlock;
        document.getElementById('image-upload-input').click();
    } else if (cmdId === 'link') {
        pendingExtLinkBlock = targetBlock; 
        document.getElementById('ext-link-title').value = ''; document.getElementById('ext-link-url').value = '';
        document.getElementById('ext-link-overlay').classList.remove('hidden');
        setTimeout(() => document.getElementById('ext-link-url').focus(), 10);
    } else if (cmdId === 'linkpage') {
        const linkSelect = document.getElementById('link-select');
        linkSelect.innerHTML = '';
        Object.values(state.pages).forEach(p => {
            if(p.id !== state.currentPageId) { 
                const opt = document.createElement('option');
                opt.value = p.id; opt.textContent = p.title || '無題'; linkSelect.appendChild(opt);
            }
        });
        document.getElementById('link-overlay').classList.remove('hidden');
        pendingExtLinkBlock = targetBlock;
    } else if (cmdId === 'page') {
        const childId = generateId();
        const childPage = { 
            id: childId, 
            title: '', 
            parentId: state.currentPageId, 
            blocks: [{ id: generateId(), type: 'p', content: '', children:[] }], 
            isLocked: false 
        };
        state.pages[childId] = childPage;

        (async () => {
            await createPageInAppwrite(childPage);
            const temp = document.createElement('div'); 
            renderBlocks([{id: targetBlock.dataset.id, type: 'page_link', content: childId, children:[]}], temp);
            targetBlock.replaceWith(temp.firstElementChild);
            saveEditorState(true); 
            renderTree(); 
            openPage(childId); 
            setTimeout(() => pageTitleEl.focus(), 10);
        })();
    } else {
        const temp = document.createElement('div'); 
        const extracted = { id: targetBlock.dataset.id, type: cmdId, content: contentEl.innerHTML, children:[] };
        if (cmdId === 'toggle') { extracted.toggleOpen = true; extracted.children = [{id: generateId(), type: 'p', content: '', children: []}]; }
        renderBlocks([extracted], temp);
        const newEl = temp.firstElementChild;
        targetBlock.replaceWith(newEl); newEl.querySelector(':scope > .block-main > .block-content').focus();
        saveEditorState(true); reinitSortables();
    }
    
}

// ================= 全部入りZIPエクスポート処理（究極の堅牢版） =================
document.getElementById('btn-export')?.addEventListener('click', async (e) => {
    const btn = e.target;
    const originalText = btn.textContent;
    btn.textContent = "エクスポート実行中...";
    btn.disabled = true;

    try {
        await exportAllDataAndImages();
    } catch (err) {
        alert("エラーが発生しました: " + err.message);
        console.error("Export Error:", err);
    } finally {
        btn.textContent = originalText;
        btn.disabled = false;
    }
});

async function exportAllDataAndImages() {
    alert("クラウドから全データを取得・統合してZIP化します。\nデータ量によって数十秒かかる場合があります。このままお待ちください...");
    
    const zip = new JSZip();
    
    // 1. ローカルの最新状態（編集中のデータ）をベースにする
    let exportData = JSON.parse(JSON.stringify(state));
    
    // 2. クラウド（Appwrite）から全ページデータを確実に取得する（ページネーション対応）
    let allPages = [];
    let lastId = null;
    let hasMore = true;

    while (hasMore) {
        // Appwrite v13 のクエリ構文
        const queries = [Query.limit(100)];
        if (lastId) queries.push(Query.cursorAfter(lastId));

        const response = await databases.listDocuments(DB_ID, COLLECTION_PAGES, queries);
        allPages.push(...response.documents);

        if (response.documents.length < 100) {
            hasMore = false;
        } else {
            lastId = response.documents[response.documents.length - 1].$id;
        }
    }

    // 3. ローカルデータに「未読み込みのページ」や「欠けているデータ」があればクラウドデータで補完
    allPages.forEach(doc => {
        let page = exportData.pages[doc.pageId];
        
        // もしローカルのstateに存在しないページがあれば追加
        if (!page) {
            exportData.pages[doc.pageId] = {
                id: doc.pageId,
                title: doc.title || '',
                parentId: doc.parentId || null,
                blocks: null,
                isLocked: doc.isLocked || false,
                password: doc.password || null
            };
            page = exportData.pages[doc.pageId];
        }

        // ブロックがまだ読み込まれていない（null または 空）場合のみクラウドデータで上書き
        // ※こうすることで、今エディタで編集したばかりの最新状態を維持できる
        if (!page.blocks || page.blocks === null || page.blocks.length === 0) {
            let parsedBlocks = doc.blocks;
            let parseAttempts = 0;
            // 稀に文字列化が二重になっていることがあるため、配列になるまで展開
            while (typeof parsedBlocks === 'string' && parseAttempts < 5) {
                try { parsedBlocks = JSON.parse(parsedBlocks); } catch (e) { break; }
                parseAttempts++;
            }
            page.blocks = Array.isArray(parsedBlocks) ? parsedBlocks : (parsedBlocks ? [parsedBlocks] : []);
        }

        // JSONに含めたくないAppwrite用のプロパティを消去
        delete page.isUnlockedSession;
        delete page.$id; 
    });

    // 4. 完成した全データを一度「ただの文字列」にする
    let jsonString = JSON.stringify(exportData, null, 2);

    // 5. 文字列全体からAppwriteの「ファイルID」を無条件で全て抽出する
    // パターン: /files/〇〇〇/view または /files/〇〇〇/download
    const fileIdRegex = /\/files\/([a-zA-Z0-9_-]+)\/(?:view|download)/g;
    const matches = [...jsonString.matchAll(fileIdRegex)];
    const fileIds = [...new Set(matches.map(m => m[1]))]; // 重複を排除

    console.log(`抽出された画像ファイルID: ${fileIds.length}件`, fileIds);

    // 6. 画像ファイルを一つずつダウンロードしてZIPに追加
    const imgFolder = zip.folder("images");
    for (const fileId of fileIds) {
        try {
            // SDKを使って安全なダウンロードURLを生成
            const urlObj = storage.getFileView(BUCKET_ID, fileId);
            const urlStr = urlObj.toString();
            
            const response = await fetch(urlStr);
            if (!response.ok) throw new Error(`HTTPエラー: ${response.status}`);
            
            const blob = await response.blob();
            imgFolder.file(`${fileId}.png`, blob);
            
        } catch (error) {
            console.warn(`画像（ID: ${fileId}）の取得に失敗しました。スキップします。`, error);
        }
    }

    // 7. JSON文字列の中にある「Appwriteの画像URL」を全て「images/〇〇.png」に一括置換
    // クォーテーションで囲まれているURLの塊を正確に捉えてローカルパスに置き換える
    const replaceRegex = /https:\/\/[^"'\\]+\/files\/([a-zA-Z0-9_-]+)\/(?:view|download)[^"'\\]*/g;
    jsonString = jsonString.replace(replaceRegex, 'images/$1.png');

    // 8. 置換済みのJSONファイルをZIPのルートに登録
    zip.file("motion_backup.json", jsonString);

    // 9. ZIPファイルを生成してダウンロード
    const zipBlob = await zip.generateAsync({ type: "blob" });
    const downloadLink = document.createElement("a");
    downloadLink.href = URL.createObjectURL(zipBlob);
    downloadLink.download = `motion_backup_${new Date().toISOString().slice(0,10)}.zip`;
    downloadLink.click();
    
    alert(`エクスポートが完了しました！\n画像 ${fileIds.length} 枚をZIPに格納しました。`);
}
// =========================================================
