(() => {
  "use strict";

  const OWNER = "sosirusok";
  const REPO = "WAG";
  const BRANCH = "main";
  const CONTENT_PATH = "data/site.json";
  const API_ROOT = "https://api.github.com";
  const DRAFT_KEY = "wag-admin-content-draft-v1";

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const escapeHtml = (value = "") => String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");

  const authView = $("[data-auth-view]");
  const adminView = $("[data-admin-view]");
  const tokenForm = $("[data-token-form]");
  const tokenInput = $("#github-token");
  const authError = $("[data-auth-error]");
  const connectButton = $("[data-connect-button]");
  const loadingScreen = $("[data-loading-screen]");
  const loadingText = $("[data-loading-text]");
  const previewDialog = $("[data-preview-dialog]");
  const historyDialog = $("[data-history-dialog]");
  const confirmDialog = $("[data-confirm-dialog]");

  let token = "";
  let content = null;
  let originalContent = null;
  let baseHead = "";
  let baseTree = "";
  let currentUser = null;
  let dirty = false;
  let autosaveTimer = 0;
  const pendingUploads = new Map();

  class ApiError extends Error {
    constructor(status, message, payload = null) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.payload = payload;
    }
  }

  const showLoading = (message) => {
    loadingText.textContent = message;
    loadingScreen.hidden = false;
  };

  const hideLoading = () => {
    loadingScreen.hidden = true;
  };

  const toast = (message, type = "info", duration = 4200) => {
    const region = $("[data-toast-region]");
    const item = document.createElement("div");
    item.className = `toast is-${type}`;
    const dot = document.createElement("i");
    const text = document.createElement("span");
    text.textContent = message;
    item.append(dot, text);
    region.append(item);
    window.setTimeout(() => item.remove(), duration);
  };

  const api = async (path, options = {}) => {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(`${API_ROOT}${path}`, {
        ...options,
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          ...(options.body ? { "Content-Type": "application/json" } : {}),
          ...(options.headers || {})
        }
      });
      const text = await response.text();
      let payload = null;
      if (text) {
        try { payload = JSON.parse(text); } catch { payload = text; }
      }
      if (!response.ok) {
        throw new ApiError(response.status, payload?.message || `관리 서버 요청 실패 (${response.status})`, payload);
      }
      return payload;
    } catch (error) {
      if (error.name === "AbortError") throw new ApiError(408, "관리 서버 응답 시간이 초과되었습니다.");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  };

  const decodeBase64Utf8 = (encoded) => {
    const binary = atob(encoded.replace(/\s/g, ""));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  };

  const formatDate = (value, includeTime = true) => {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return "기록 없음";
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      ...(includeTime ? { hour: "2-digit", minute: "2-digit" } : {})
    }).format(date);
  };

  const pathParts = (path) => path.split(".").map((part) => /^\d+$/.test(part) ? Number(part) : part);

  const setByPath = (target, path, value) => {
    const parts = pathParts(path);
    let cursor = target;
    parts.slice(0, -1).forEach((part) => { cursor = cursor[part]; });
    cursor[parts.at(-1)] = value;
  };

  const getByPath = (target, path) => pathParts(path).reduce((value, part) => value?.[part], target);

  const fileUrl = (path) => {
    if (!path) return "";
    const pending = pendingUploads.get(path);
    if (pending) return pending.preview;
    if (/^https?:\/\//i.test(path) || /^data:image\//i.test(path)) return path;
    const encoded = path.split("/").map(encodeURIComponent).join("/");
    return `https://raw.githubusercontent.com/${OWNER}/${REPO}/${baseHead}/${encoded}`;
  };

  const updateDirtyState = () => {
    dirty = Boolean(content && originalContent) && (
      JSON.stringify(content) !== JSON.stringify(originalContent) || pendingUploads.size > 0
    );
    const stateLabel = $("[data-change-state]");
    const dot = $("[data-dirty-dot]");
    const publish = $("[data-publish-button]");
    const sync = $("[data-sync-state]");
    if (dirty) {
      stateLabel.textContent = pendingUploads.size
        ? `게시되지 않은 변경과 새 이미지 ${pendingUploads.size}개가 있습니다.`
        : "게시되지 않은 변경이 있습니다.";
      dot.classList.add("is-dirty");
      publish.disabled = false;
      sync.classList.add("is-dirty");
      sync.classList.remove("is-error");
      $("span", sync).textContent = "게시 전 변경 있음";
      scheduleDraftSave();
    } else {
      stateLabel.textContent = "게시된 내용과 같습니다.";
      dot.classList.remove("is-dirty");
      publish.disabled = true;
      sync.classList.remove("is-dirty", "is-error");
      $("span", sync).textContent = "내용 불러옴";
    }
    renderDashboardSummary();
  };

  const scheduleDraftSave = () => {
    window.clearTimeout(autosaveTimer);
    autosaveTimer = window.setTimeout(() => {
      if (!dirty || !content) return;
      if (pendingUploads.size) {
        localStorage.removeItem(DRAFT_KEY);
        return;
      }
      try {
        localStorage.setItem(DRAFT_KEY, JSON.stringify({ baseHead, savedAt: new Date().toISOString(), content }));
      } catch {
        toast("브라우저 임시 저장 공간이 부족합니다. 게시 전 페이지를 닫지 마세요.", "error");
      }
    }, 650);
  };

  const checkSavedDraft = () => {
    const notice = $("[data-draft-notice]");
    try {
      const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || "null");
      if (!saved?.content || saved.baseHead !== baseHead || JSON.stringify(saved.content) === JSON.stringify(content)) {
        notice.hidden = true;
        return;
      }
      $("[data-draft-time]").textContent = `${formatDate(saved.savedAt)} 임시 저장`;
      notice.hidden = false;
      notice.dataset.savedDraft = JSON.stringify(saved);
    } catch {
      localStorage.removeItem(DRAFT_KEY);
      notice.hidden = true;
    }
  };

  const assertEditableContent = (candidate) => {
    const validObject = (value) => value && typeof value === "object" && !Array.isArray(value);
    const valid = validObject(candidate)
      && candidate?.meta?.version === 3
      && validObject(candidate.meta)
      && validObject(candidate.brand)
      && validObject(candidate.contact)
      && ["projects", "services", "capabilities", "process", "faq"].every((key) => Array.isArray(candidate[key]));
    if (!valid) throw new ApiError(422, "현재 관리 도구에서 지원하지 않는 콘텐츠 형식입니다. 최신 사이트 내용을 확인해 주세요.");
  };

  const loadRepositoryContent = async () => {
    const ref = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
    baseHead = ref.object.sha;
    const commit = await api(`/repos/${OWNER}/${REPO}/git/commits/${baseHead}`);
    baseTree = commit.tree.sha;
    const file = await api(`/repos/${OWNER}/${REPO}/contents/${CONTENT_PATH}?ref=${encodeURIComponent(baseHead)}`);
    const parsed = JSON.parse(decodeBase64Utf8(file.content));
    assertEditableContent(parsed);
    content = parsed;
    originalContent = clone(parsed);
    pendingUploads.clear();
    dirty = false;
  };

  const connect = async (candidateToken) => {
    token = candidateToken.trim();
    if (token.length < 20) throw new ApiError(401, "올바른 관리 키를 입력해 주세요.");
    showLoading("관리 권한을 확인하는 중입니다.");
    currentUser = await api("/user");
    if (currentUser.login !== OWNER) {
      throw new ApiError(403, "등록된 관리자 계정의 관리 키가 아닙니다.");
    }
    const repository = await api(`/repos/${OWNER}/${REPO}`);
    if (!repository.permissions?.push) {
      throw new ApiError(403, "이 관리 키에는 사이트 수정 권한이 없습니다.");
    }
    loadingText.textContent = "사이트 내용을 불러오는 중입니다.";
    await loadRepositoryContent();
    tokenInput.value = "";
    authView.hidden = true;
    adminView.hidden = false;
    $("[data-user-login]").textContent = currentUser.login;
    const avatar = $("[data-user-avatar]");
    avatar.src = currentUser.avatar_url || "";
    avatar.alt = `${currentUser.login} 프로필`;
    renderAll();
    checkSavedDraft();
    openSection(sectionFromHash(), { updateHash: false, scroll: false });
    hideLoading();
  };

  const readableAuthError = (error) => {
    if (error.status === 401) return "관리 키가 유효하지 않거나 만료되었습니다.";
    if (error.status === 403) return error.message || "사이트 수정 권한이 부족합니다.";
    if (error.status === 404) return "사이트 콘텐츠를 찾을 수 없습니다.";
    if (error.status === 408) return error.message;
    return error.message || "연결 중 문제가 발생했습니다.";
  };

  tokenForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    authError.textContent = "";
    connectButton.disabled = true;
    try {
      await connect(tokenInput.value);
    } catch (error) {
      token = "";
      authError.textContent = readableAuthError(error);
      hideLoading();
    } finally {
      connectButton.disabled = false;
    }
  });

  $("[data-token-toggle]").addEventListener("click", (event) => {
    const visible = tokenInput.type === "text";
    tokenInput.type = visible ? "password" : "text";
    event.currentTarget.textContent = visible ? "보기" : "숨김";
    event.currentTarget.setAttribute("aria-pressed", String(!visible));
    event.currentTarget.setAttribute("aria-label", visible ? "관리 키 표시" : "관리 키 숨기기");
  });

  const controlId = (path) => `field-${String(path).replace(/[^a-zA-Z0-9_-]+/g, "-")}`;

  const inputField = ({ label, path, value, type = "text", help = "", full = false, max = 0, placeholder = "" }) => {
    const id = controlId(path);
    const helpId = `${id}-help`;
    return `
      <div class="field${full ? " full" : ""}">
        <label for="${id}">${escapeHtml(label)}${max ? `<small aria-hidden="true">${String(value || "").length} / ${max}</small>` : ""}</label>
        <input id="${id}" type="${escapeHtml(type)}" data-path="${escapeHtml(path)}" value="${escapeHtml(value)}"${max ? ` maxlength="${max}"` : ""}${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ""}${help ? ` aria-describedby="${helpId}"` : ""}>
        ${help ? `<p class="field-help" id="${helpId}">${escapeHtml(help)}</p>` : ""}
      </div>`;
  };

  const textareaField = ({ label, path, value, help = "", full = true, max = 0, short = false }) => {
    const id = controlId(path);
    const helpId = `${id}-help`;
    return `
      <div class="field${full ? " full" : ""}">
        <label for="${id}">${escapeHtml(label)}${max ? `<small aria-hidden="true">${String(value || "").length} / ${max}</small>` : ""}</label>
        <textarea id="${id}" class="${short ? "short" : ""}" data-path="${escapeHtml(path)}"${max ? ` maxlength="${max}"` : ""}${help ? ` aria-describedby="${helpId}"` : ""}>${escapeHtml(value)}</textarea>
        ${help ? `<p class="field-help" id="${helpId}">${escapeHtml(help)}</p>` : ""}
      </div>`;
  };

  const editorCard = (title, subtitle, body, actions = "") => `
    <article class="editor-card">
      <header class="editor-card-header">
        <div><h2>${escapeHtml(title)}</h2>${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}</div>
        ${actions ? `<div class="editor-card-actions">${actions}</div>` : ""}
      </header>
      <div class="editor-card-body">${body}</div>
    </article>`;

  const renderBasic = () => {
    const root = $("[data-basic-editor]");
    root.innerHTML = [
      editorCard("검색 및 공유 정보", "검색 결과와 카카오톡 링크 미리보기에 사용됩니다.", `
        <div class="field-grid">
          ${inputField({ label: "사이트 제목", path: "meta.title", value: content.meta.title, max: 60 })}
          ${textareaField({ label: "사이트 설명", path: "meta.description", value: content.meta.description, max: 160 })}
        </div>`),
      editorCard("첫 화면", "고객이 처음 보는 제목과 소개 문구입니다.", `
        <div class="field-grid">
          ${inputField({ label: "브랜드 영문 표기", path: "brand.expansion", value: content.brand.expansion, max: 40 })}
          ${inputField({ label: "제작 분야 한 줄", path: "brand.headline", value: content.brand.headline, max: 40 })}
          ${inputField({ label: "기본 문의 버튼", path: "brand.primaryCta", value: content.brand.primaryCta, max: 24 })}
          ${inputField({ label: "보조 버튼", path: "brand.secondaryCta", value: content.brand.secondaryCta, max: 24 })}
          ${textareaField({ label: "첫 화면 설명", path: "brand.description", value: content.brand.description, max: 220 })}
          ${textareaField({ label: "문의 영역 안내", path: "contact.responseNote", value: content.contact.responseNote, max: 180, short: true })}
        </div>`),
      editorCard("연락처", "사이트 푸터와 문의 영역에 표시됩니다.", `
        <div class="field-grid">
          ${inputField({ label: "운영자", path: "contact.owner", value: content.contact.owner, max: 20 })}
          ${inputField({ label: "전화번호", path: "contact.phone", value: content.contact.phone, max: 20 })}
          ${inputField({ label: "카카오 상담 주소", path: "contact.kakao", value: content.contact.kakao, type: "url", full: true, help: "https://로 시작하는 오픈채팅 주소를 입력합니다." })}
          ${inputField({ label: "상담 링크 이름", path: "contact.kakaoLabel", value: content.contact.kakaoLabel, max: 30 })}
        </div>`)
    ].join("");
  };

  const renderItems = (items, arrayPath, groupLabel = "항목") => `
    <div class="items-editor">
      ${(items || []).map((item, index) => {
        const path = `${arrayPath}.${index}`;
        return `<div class="item-row"><input id="${controlId(path)}" data-path="${escapeHtml(path)}" value="${escapeHtml(item)}" aria-label="${escapeHtml(`${groupLabel} ${index + 1}`)}"><button type="button" data-action="remove-array-item" data-array-path="${escapeHtml(arrayPath)}" data-index="${index}" aria-label="${escapeHtml(`${groupLabel} ${index + 1} 삭제`)}">×</button></div>`;
      }).join("")}
      <button class="add-item-button" type="button" data-action="add-array-item" data-array-path="${escapeHtml(arrayPath)}" aria-label="${escapeHtml(`${groupLabel} 항목 추가`)}">＋ 항목 추가</button>
    </div>`;

  const moveActions = (collection, index, length, allowDelete = true) => `
    <button type="button" data-action="move-up" data-collection="${collection}" data-index="${index}"${index === 0 ? " disabled" : ""} aria-label="위로 이동">↑</button>
    <button type="button" data-action="move-down" data-collection="${collection}" data-index="${index}"${index === length - 1 ? " disabled" : ""} aria-label="아래로 이동">↓</button>
    ${allowDelete ? `<button type="button" class="danger-button" data-action="delete-entry" data-collection="${collection}" data-index="${index}">삭제</button>` : ""}`;

  const renderServices = () => {
    const root = $("[data-services-editor]");
    if (!content.services.length) {
      root.innerHTML = `<div class="empty-editor"><div><b>등록된 서비스가 없습니다.</b><span>오른쪽 위 버튼을 눌러 서비스 영역을 추가하세요.</span></div></div>`;
      return;
    }
    root.innerHTML = content.services.map((service, index) => editorCard(
      `${String(index + 1).padStart(2, "0")} / ${service.title || "새 서비스"}`,
      service.short || "설명을 입력해 주세요.",
      `<div class="field-grid three">
        ${inputField({ label: "서비스 이름", path: `services.${index}.title`, value: service.title, max: 18 })}
        ${inputField({ label: "짧은 소개", path: `services.${index}.short`, value: service.short, max: 40 })}
        ${textareaField({ label: "설명", path: `services.${index}.description`, value: service.description, max: 180 })}
        <div class="field full"><div class="field-label">제공 항목</div>${renderItems(service.items || [], `services.${index}.items`, "제공 항목")}</div>
      </div>`,
      moveActions("services", index, content.services.length)
    )).join("");
  };

  const projectCover = (project) => {
    const source = fileUrl(project.image);
    if (source) return `<img src="${escapeHtml(source)}" alt="${escapeHtml(project.imageAlt || project.title)}">`;
    return `<div class="project-cover-placeholder"><span>SWAG / PROJECT</span><b>${escapeHtml(project.title || "NEW WORK")}</b></div>`;
  };

  const renderProjects = () => {
    const root = $("[data-projects-editor]");
    if (!content.projects.length) {
      root.innerHTML = `<div class="empty-editor"><div><b>등록된 작업 사례가 없습니다.</b><span>새 작업을 추가하면 사이트의 작업 영역에 표시할 수 있습니다.</span></div></div>`;
      return;
    }
    content.projects.forEach((project, index) => { project.order = index + 1; });
    root.innerHTML = content.projects.map((project, index) => `
      <article class="project-editor" data-project-editor="${escapeHtml(project.id)}">
        <div class="project-media-editor">
          <div class="project-cover">${projectCover(project)}</div>
          <div>
            <div class="image-actions">
              <label class="image-upload-label">이미지 선택<input type="file" accept="image/jpeg,image/png,image/webp" data-project-image="${escapeHtml(project.id)}"></label>
              <button class="image-remove" type="button" data-action="remove-image" data-project-id="${escapeHtml(project.id)}" aria-label="${escapeHtml(`${project.title || "작업"} 이미지 삭제`)}">삭제</button>
            </div>
            <p class="image-note">JPG, PNG, WebP. 1800 × 1200px 범위의 WebP로 자동 최적화합니다.</p>
          </div>
        </div>
        <div class="project-editor-main">
          <header class="editor-card-header">
            <div><h3><span class="project-order">${String(index + 1).padStart(2, "0")}</span>${escapeHtml(project.title || "새 작업")}</h3><p>${project.published ? "사이트에 공개 중" : "비공개 상태"}</p></div>
            <div class="editor-card-actions">${moveActions("projects", index, content.projects.length)}</div>
          </header>
          <div class="editor-card-body">
            <div class="toggle-row">
              <label class="switch-field"><input type="checkbox" data-path="projects.${index}.published"${project.published ? " checked" : ""}><span class="switch-ui"></span><span>사이트 공개</span></label>
            </div>
            <div class="field-grid three">
              ${inputField({ label: "작업 제목", path: `projects.${index}.title`, value: project.title, max: 50, full: true })}
              ${inputField({ label: "분류", path: `projects.${index}.category`, value: project.category, max: 30 })}
              ${inputField({ label: "연도", path: `projects.${index}.year`, value: project.year, max: 6 })}
              ${textareaField({ label: "목록 소개", path: `projects.${index}.summary`, value: project.summary, max: 220 })}
              ${textareaField({ label: "고객의 문제", path: `projects.${index}.problem`, value: project.problem, max: 260 })}
              ${textareaField({ label: "구축 내용", path: `projects.${index}.solution`, value: project.solution, max: 260 })}
              ${textareaField({ label: "완성 결과", path: `projects.${index}.result`, value: project.result, max: 260 })}
              ${inputField({ label: "이미지 설명", path: `projects.${index}.imageAlt`, value: project.imageAlt || "", max: 100, full: true, help: "이미지를 사용하는 경우 화면을 볼 수 없는 방문자를 위해 반드시 입력합니다." })}
              ${inputField({ label: "외부 사이트 주소", path: `projects.${index}.url`, value: project.url || "", type: "url", full: true, help: "공개할 주소가 없다면 비워 두세요." })}
              <div class="field full"><div class="field-label">구현 기능</div>${renderItems(project.features, `projects.${index}.features`, "구현 기능")}</div>
            </div>
          </div>
        </div>
      </article>`).join("");
  };

  const renderProcess = () => {
    const root = $("[data-process-editor]");
    root.innerHTML = content.process.length ? content.process.map((item, index) => editorCard(
      `${String(index + 1).padStart(2, "0")} / ${item.title || "새 단계"}`,
      item.description || "설명을 입력해 주세요.",
      `<div class="field-grid three">
        ${inputField({ label: "단계 이름", path: `process.${index}.title`, value: item.title, max: 35 })}
        ${textareaField({ label: "설명", path: `process.${index}.description`, value: item.description, max: 180 })}
        ${textareaField({ label: "확인 항목", path: `process.${index}.result`, value: item.result, max: 120, short: true })}
      </div>`,
      moveActions("process", index, content.process.length)
    )).join("") : `<div class="empty-editor"><div><b>등록된 진행 단계가 없습니다.</b><span>단계를 추가해 고객에게 작업 흐름을 안내하세요.</span></div></div>`;
  };

  const renderFaq = () => {
    const root = $("[data-faq-editor]");
    root.innerHTML = content.faq.length ? content.faq.map((item, index) => editorCard(
      `Q${String(index + 1).padStart(2, "0")} / ${item.question || "새 질문"}`,
      "사이트 FAQ 영역에 표시됩니다.",
      `<div class="field-grid">
        ${inputField({ label: "질문", path: `faq.${index}.question`, value: item.question, max: 100, full: true })}
        ${textareaField({ label: "답변", path: `faq.${index}.answer`, value: item.answer, max: 400 })}
      </div>`,
      moveActions("faq", index, content.faq.length)
    )).join("") : `<div class="empty-editor"><div><b>등록된 질문이 없습니다.</b><span>자주 받는 질문을 추가해 문의 전 이탈을 줄이세요.</span></div></div>`;
  };

  const renderDashboardSummary = () => {
    if (!content) return;
    $("[data-metric-projects]").textContent = String(content.projects.filter((project) => project.published).length).padStart(2, "0");
    $("[data-metric-services]").textContent = String(content.services.length).padStart(2, "0");
    $("[data-metric-faq]").textContent = String(content.faq.length).padStart(2, "0");
    $("[data-metric-state]").textContent = dirty ? "수정 중" : "저장됨";
    $("[data-summary-title]").textContent = content.meta.title;
    $("[data-summary-updated]").textContent = formatDate(content.meta.updatedAt);
  };

  const renderAll = () => {
    renderBasic();
    renderServices();
    renderProjects();
    renderProcess();
    renderFaq();
    updateDirtyState();
  };

  const SECTION_NAMES = new Set($$("[data-section]").map((section) => section.dataset.section));
  const sectionFromHash = () => {
    const candidate = window.location.hash.slice(1);
    return SECTION_NAMES.has(candidate) ? candidate : "dashboard";
  };

  const openSection = (name, { updateHash = true, scroll = true } = {}) => {
    const next = SECTION_NAMES.has(name) ? name : "dashboard";
    $$("[data-section]").forEach((section) => section.classList.toggle("is-active", section.dataset.section === next));
    $$("[data-section-target]").forEach((button) => {
      const active = button.dataset.sectionTarget === next;
      button.classList.toggle("is-active", active);
      if (active) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    });
    $("[data-sidebar]").classList.remove("is-open");
    $("[data-sidebar-toggle]").setAttribute("aria-expanded", "false");
    $("[data-sidebar-toggle]").setAttribute("aria-label", "관리 메뉴 열기");
    if (updateHash && window.location.hash !== `#${next}`) history.pushState(null, "", `#${next}`);
    if (scroll) window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  };

  $$("[data-section-target]").forEach((button) => button.addEventListener("click", () => openSection(button.dataset.sectionTarget)));
  $$("[data-section-jump]").forEach((button) => button.addEventListener("click", () => openSection(button.dataset.sectionJump)));
  $(".admin-logo").addEventListener("click", (event) => {
    event.preventDefault();
    openSection("dashboard");
  });
  window.addEventListener("popstate", () => openSection(sectionFromHash(), { updateHash: false }));
  $("[data-sidebar-toggle]").addEventListener("click", (event) => {
    const open = $("[data-sidebar]").classList.toggle("is-open");
    event.currentTarget.setAttribute("aria-expanded", String(open));
    event.currentTarget.setAttribute("aria-label", open ? "관리 메뉴 닫기" : "관리 메뉴 열기");
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    $("[data-sidebar]").classList.remove("is-open");
    $("[data-sidebar-toggle]").setAttribute("aria-expanded", "false");
    $("[data-sidebar-toggle]").setAttribute("aria-label", "관리 메뉴 열기");
  });

  document.addEventListener("input", (event) => {
    const field = event.target.closest("[data-path]");
    if (!field || !content) return;
    let value = field.type === "checkbox" ? field.checked : field.value;
    if (field.type === "number") value = Number(value);
    setByPath(content, field.dataset.path, value);
    const counter = field.closest(".field")?.querySelector("label small");
    if (counter && field.maxLength > 0) counter.textContent = `${String(value).length} / ${field.maxLength}`;
    updateDirtyState();
  });

  document.addEventListener("change", async (event) => {
    const fileInput = event.target.closest("[data-project-image]");
    if (!fileInput?.files?.[0]) return;
    const project = content.projects.find((item) => item.id === fileInput.dataset.projectImage);
    if (!project) return;
    try {
      showLoading("이미지를 최적화하는 중입니다.");
      const optimized = await optimizeImage(fileInput.files[0]);
      const path = `assets/uploads/${project.id}-${Date.now()}.webp`;
      if (pendingUploads.has(project.image)) pendingUploads.delete(project.image);
      pendingUploads.set(path, optimized);
      project.image = path;
      if (!project.imageAlt) project.imageAlt = `${project.title} 화면`;
      renderProjects();
      updateDirtyState();
      toast(`${Math.round(optimized.size / 1024)}KB WebP 이미지로 최적화했습니다.`, "success");
    } catch (error) {
      toast(error.message || "이미지를 처리하지 못했습니다.", "error");
    } finally {
      hideLoading();
    }
  });

  const optimizeImage = async (file) => {
    if (!/^image\/(jpeg|png|webp)$/.test(file.type)) throw new Error("JPG, PNG 또는 WebP 이미지만 사용할 수 있습니다.");
    if (file.size > 12 * 1024 * 1024) throw new Error("원본 이미지는 12MB 이하여야 합니다.");
    const bitmap = await createImageBitmap(file);
    const maxWidth = 1800;
    const maxHeight = 1200;
    const scale = Math.min(1, maxWidth / bitmap.width, maxHeight / bitmap.height);
    const width = Math.max(1, Math.round(bitmap.width * scale));
    const height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d", { alpha: false });
    context.fillStyle = "#f5f6f8";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const makeBlob = (quality) => new Promise((resolve) => canvas.toBlob(resolve, "image/webp", quality));
    let blob = await makeBlob(.84);
    if (!blob) throw new Error("이 브라우저에서는 WebP 변환을 지원하지 않습니다.");
    if (blob.size > 1024 * 1024) blob = await makeBlob(.7);
    if (!blob || blob.size > 1.5 * 1024 * 1024) throw new Error("최적화 후 이미지가 너무 큽니다. 더 작은 이미지를 사용해 주세요.");
    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
    return { base64: String(dataUrl).split(",")[1], preview: dataUrl, size: blob.size };
  };

  const createBlankProject = () => ({
    id: `project-${Date.now()}`,
    order: content.projects.length + 1,
    published: false,
    title: "새 작업",
    category: "WEB",
    year: String(new Date().getFullYear()),
    summary: "",
    problem: "",
    solution: "",
    result: "",
    features: [],
    image: "",
    imageAlt: "",
    url: ""
  });

  $("[data-add-project]").addEventListener("click", () => {
    content.projects.push(createBlankProject());
    renderProjects();
    updateDirtyState();
    openSection("projects");
    requestAnimationFrame(() => $$("[data-project-editor]").at(-1)?.scrollIntoView({ behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" }));
  });

  $("[data-add-service]").addEventListener("click", () => {
    content.services.push({ id: `service-${Date.now()}`, title: "새 서비스", short: "짧은 소개", description: "", items: [] });
    renderServices();
    updateDirtyState();
  });

  $("[data-add-process]").addEventListener("click", () => {
    content.process.push({ title: "새 단계", description: "", result: "" });
    renderProcess();
    updateDirtyState();
  });

  $("[data-add-faq]").addEventListener("click", () => {
    content.faq.push({ question: "새 질문", answer: "" });
    renderFaq();
    updateDirtyState();
  });

  const rerenderCollection = (collection) => {
    if (collection === "projects") renderProjects();
    if (collection === "services") renderServices();
    if (collection === "process") renderProcess();
    if (collection === "faq") renderFaq();
  };

  document.addEventListener("click", (event) => {
    const action = event.target.closest("[data-action]");
    if (!action || !content) return;
    const type = action.dataset.action;
    if (type === "add-array-item") {
      let list = getByPath(content, action.dataset.arrayPath);
      if (!Array.isArray(list)) {
        setByPath(content, action.dataset.arrayPath, []);
        list = getByPath(content, action.dataset.arrayPath);
      }
      list.push("");
      rerenderCollection(action.dataset.arrayPath.split(".")[0]);
      updateDirtyState();
      return;
    }
    if (type === "remove-array-item") {
      getByPath(content, action.dataset.arrayPath).splice(Number(action.dataset.index), 1);
      rerenderCollection(action.dataset.arrayPath.split(".")[0]);
      updateDirtyState();
      return;
    }
    if (type === "remove-image") {
      const project = content.projects.find((item) => item.id === action.dataset.projectId);
      if (!project) return;
      if (project.image) pendingUploads.delete(project.image);
      project.image = "";
      renderProjects();
      updateDirtyState();
      return;
    }
    const collection = action.dataset.collection;
    const list = content[collection];
    const index = Number(action.dataset.index);
    if (!Array.isArray(list) || !Number.isInteger(index)) return;
    if (type === "move-up" && index > 0) [list[index - 1], list[index]] = [list[index], list[index - 1]];
    if (type === "move-down" && index < list.length - 1) [list[index + 1], list[index]] = [list[index], list[index + 1]];
    if (type === "delete-entry") {
      if (!window.confirm("이 항목을 삭제할까요? 게시하기 전까지는 사이트에 반영되지 않습니다.")) return;
      const removed = list.splice(index, 1)[0];
      if (collection === "projects" && removed?.image) pendingUploads.delete(removed.image);
    }
    rerenderCollection(collection);
    updateDirtyState();
  });

  const validateContent = (candidate = content) => {
    const errors = [];
    const required = (value, label) => {
      if (typeof value !== "string" || !value.trim()) errors.push(`${label}을 입력해 주세요.`);
    };
    const stringArray = (value, label, { allowEmpty = false } = {}) => {
      if (!Array.isArray(value) || (!allowEmpty && value.length < 1) || value.some((item) => typeof item !== "string" || !item.trim())) {
        errors.push(`${label}에 빈 항목 없이 한 개 이상 입력해 주세요.`);
      }
    };
    const projects = Array.isArray(candidate?.projects) ? candidate.projects : [];
    const services = Array.isArray(candidate?.services) ? candidate.services : [];
    const capabilities = Array.isArray(candidate?.capabilities) ? candidate.capabilities : [];
    const processSteps = Array.isArray(candidate?.process) ? candidate.process : [];
    const faqItems = Array.isArray(candidate?.faq) ? candidate.faq : [];

    if (typeof candidate?.meta?.version !== "number" || candidate.meta.version < 47) errors.push("지원하지 않는 콘텐츠 버전입니다. 최신 사이트 내용을 다시 불러와 주세요.");
    required(candidate?.meta?.title, "사이트 제목");
    required(candidate?.meta?.description, "사이트 설명");
    required(candidate?.brand?.name, "브랜드 이름");
    required(candidate?.brand?.headline, "제작 분야 한 줄");
    required(candidate?.brand?.description, "첫 화면 설명");
    required(candidate?.contact?.owner, "운영자");
    required(candidate?.contact?.phone, "전화번호");
    if (String(candidate?.contact?.phone || "").replace(/\D/g, "").length < 9) errors.push("전화번호를 다시 확인해 주세요.");
    try {
      const url = new URL(candidate?.contact?.kakao);
      if (url.protocol !== "https:") throw new Error();
    } catch { errors.push("카카오 상담 주소는 https://로 시작해야 합니다."); }

    if (!Array.isArray(candidate?.projects)) errors.push("작업 사례 데이터 형식이 올바르지 않습니다.");
    if (!Array.isArray(candidate?.services)) errors.push("서비스 데이터 형식이 올바르지 않습니다.");
    if (!Array.isArray(candidate?.capabilities)) errors.push("기능 목록 데이터 형식이 올바르지 않습니다.");
    if (!Array.isArray(candidate?.process)) errors.push("진행 절차 데이터 형식이 올바르지 않습니다.");
    if (!Array.isArray(candidate?.faq)) errors.push("자주 묻는 질문 데이터 형식이 올바르지 않습니다.");

    if (services.length !== 4) errors.push("사이트 레이아웃 기준으로 서비스는 정확히 4개여야 합니다.");
    const serviceIds = new Set();
    services.forEach((service, index) => {
      required(service?.id, `서비스 ${index + 1}의 내부 ID`);
      required(service?.title, `서비스 ${index + 1}의 이름`);
      required(service?.short, `서비스 ${index + 1}의 짧은 소개`);
      required(service?.description, `서비스 ${index + 1}의 설명`);
      if (service?.id && !/^[a-z0-9][a-z0-9-]*$/.test(service.id)) errors.push(`서비스 ${index + 1}의 내부 ID 형식이 올바르지 않습니다.`);
      if (serviceIds.has(service?.id)) errors.push(`서비스 ${index + 1}의 내부 ID가 중복되었습니다.`);
      serviceIds.add(service?.id);
      stringArray(service?.items, `서비스 ${index + 1}의 제공 항목`);
      if (Array.isArray(service?.items) && service.items.length < 4) errors.push(`서비스 ${index + 1}의 제공 항목을 네 개 이상 입력해 주세요.`);
    });

    const projectIds = new Set();
    projects.forEach((project, index) => {
      required(project?.id, `작업 ${index + 1}의 내부 ID`);
      required(project?.title, `작업 ${index + 1}의 제목`);
      if (project?.id && !/^[a-z0-9][a-z0-9-]*$/.test(project.id)) errors.push(`작업 ${index + 1}의 내부 ID 형식이 올바르지 않습니다.`);
      if (projectIds.has(project?.id)) errors.push(`작업 ${index + 1}의 내부 ID가 중복되었습니다.`);
      projectIds.add(project?.id);
      if (project?.published) {
        required(project?.category, `공개 작업 ${index + 1}의 분류`);
        required(project?.year, `공개 작업 ${index + 1}의 연도`);
        required(project?.summary, `공개 작업 ${index + 1}의 소개`);
        required(project?.problem, `공개 작업 ${index + 1}의 문제 설명`);
        required(project?.solution, `공개 작업 ${index + 1}의 구축 내용`);
        required(project?.result, `공개 작업 ${index + 1}의 결과`);
        required(project?.image, `공개 작업 ${index + 1}의 이미지`);
        required(project?.imageAlt, `공개 작업 ${index + 1}의 이미지 설명`);
        stringArray(project?.features, `공개 작업 ${index + 1}의 구현 기능`);
      }
      if (project?.image) {
        if (project.image.startsWith("assets/")) {
          if (!/^assets\/[a-zA-Z0-9_./-]+$/.test(project.image) || project.image.includes("..")) errors.push(`작업 ${index + 1}의 이미지 경로가 올바르지 않습니다.`);
        } else {
          try {
            const imageUrl = new URL(project.image);
            if (imageUrl.protocol !== "https:") throw new Error();
          } catch { errors.push(`작업 ${index + 1}의 이미지는 안전한 사이트 이미지 경로나 HTTPS 주소여야 합니다.`); }
        }
      }
      if (project?.url) {
        try {
          const url = new URL(project.url);
          if (url.protocol !== "https:") throw new Error();
        } catch { errors.push(`작업 ${index + 1}의 외부 주소는 https://로 시작해야 합니다.`); }
      }
    });

    if (!projects.some((project) => project?.published)) errors.push("사이트에 공개할 작업 사례를 한 개 이상 설정해 주세요.");
    stringArray(capabilities, "기능 목록");
    if (processSteps.length < 4) errors.push("진행 절차를 네 개 이상 등록해 주세요.");
    processSteps.forEach((step, index) => {
      required(step?.title, `진행 절차 ${index + 1}의 이름`);
      required(step?.description, `진행 절차 ${index + 1}의 설명`);
      required(step?.result, `진행 절차 ${index + 1}의 확인 항목`);
    });
    if (!faqItems.length) errors.push("자주 묻는 질문을 한 개 이상 등록해 주세요.");
    faqItems.forEach((item, index) => {
      required(item?.question, `자주 묻는 질문 ${index + 1}의 질문`);
      required(item?.answer, `자주 묻는 질문 ${index + 1}의 답변`);
    });
    return errors;
  };

  const repositoryFileExists = async (path) => {
    const candidates = [path, `src/${path}`];
    for (const candidate of candidates) {
      const encoded = candidate.split("/").map(encodeURIComponent).join("/");
      try {
        await api(`/repos/${OWNER}/${REPO}/contents/${encoded}?ref=${encodeURIComponent(baseHead)}`);
        return true;
      } catch (error) {
        if (error.status !== 404) throw error;
      }
    }
    return false;
  };

  const validateManagedImages = async () => {
    const errors = [];
    const paths = [...new Set((content.projects || [])
      .filter((project) => typeof project?.image === "string" && project.image.startsWith("assets/") && !pendingUploads.has(project.image))
      .map((project) => project.image))];
    const checks = await Promise.all(paths.map(async (path) => ({ path, exists: await repositoryFileExists(path) })));
    checks.filter((check) => !check.exists).forEach((check) => errors.push(`등록된 이미지 파일을 찾을 수 없습니다: ${check.path}`));
    return errors;
  };

  const previewDraft = () => {
    const visible = content.projects.filter((project) => project.published).slice(0, 4);
    $("[data-draft-preview]").innerHTML = `
      <div class="preview-brand"><b>SWAG</b><span>${escapeHtml(content.brand.expansion || "SYSTEM · WEBSITE · APP · GAME")}</span></div>
      <div class="preview-hero">
        <div><small>${escapeHtml(content.brand.expansion || "")}</small><h2>${escapeHtml(content.brand.headline || "")}</h2><p>${escapeHtml(content.brand.description || "")}</p></div>
        <div class="preview-hero-art">SWAG</div>
      </div>
      <div class="preview-projects">${visible.length ? visible.map((project) => `<article class="preview-project"><span>${escapeHtml(project.category)} / ${escapeHtml(project.year)}</span><h3>${escapeHtml(project.title)}</h3><p>${escapeHtml(project.summary)}</p></article>`).join("") : `<article class="preview-project"><span>PORTFOLIO</span><h3>공개 작업 없음</h3><p>작업 사례에서 사이트 공개를 켜면 이곳에 표시됩니다.</p></article>`}</div>`;
    previewDialog.showModal();
    document.body.classList.add("has-dialog");
  };

  $$("[data-preview-button]").forEach((button) => button.addEventListener("click", previewDraft));
  $("[data-preview-close]").addEventListener("click", () => previewDialog.close());
  previewDialog.addEventListener("close", () => document.body.classList.remove("has-dialog"));

  const openHistory = async () => {
    historyDialog.showModal();
    document.body.classList.add("has-dialog");
    const root = $("[data-history-list]");
    root.innerHTML = `<div class="history-empty">게시 이력을 불러오는 중입니다.</div>`;
    try {
      const commits = await api(`/repos/${OWNER}/${REPO}/commits?path=${encodeURIComponent(CONTENT_PATH)}&sha=${BRANCH}&per_page=10`);
      if (!commits.length) {
        root.innerHTML = `<div class="history-empty">아직 게시 이력이 없습니다.</div>`;
        return;
      }
      root.innerHTML = commits.map((commit, index) => `
        <article class="history-item">
          <div><time>${escapeHtml(formatDate(commit.commit.author.date))}</time></div>
          <div><b>${escapeHtml(commit.commit.message.split("\n")[0])}</b><span>${index === 0 ? "현재 게시 기준" : "이전 버전"}</span></div>
          <button type="button" data-restore-sha="${escapeHtml(commit.sha)}">${index === 0 ? "다시 불러오기" : "내용 불러오기"}</button>
        </article>`).join("");
    } catch (error) {
      root.innerHTML = `<div class="history-empty">${escapeHtml(error.message || "게시 이력을 불러오지 못했습니다.")}</div>`;
    }
  };

  $("[data-history-button]").addEventListener("click", openHistory);
  $("[data-history-close]").addEventListener("click", () => historyDialog.close());
  historyDialog.addEventListener("close", () => document.body.classList.remove("has-dialog"));

  $("[data-history-list]").addEventListener("click", async (event) => {
    const button = event.target.closest("[data-restore-sha]");
    if (!button) return;
    try {
      showLoading("선택한 버전의 내용을 불러오는 중입니다.");
      const file = await api(`/repos/${OWNER}/${REPO}/contents/${CONTENT_PATH}?ref=${encodeURIComponent(button.dataset.restoreSha)}`);
      const restored = JSON.parse(decodeBase64Utf8(file.content));
      assertEditableContent(restored);
      content = restored;
      pendingUploads.clear();
      renderAll();
      historyDialog.close();
      toast("이전 내용을 편집 화면에 불러왔습니다. 게시해야 사이트에 반영됩니다.", "success");
    } catch (error) {
      toast(error.message || "이전 버전을 불러오지 못했습니다.", "error");
    } finally {
      hideLoading();
    }
  });

  const publish = async () => {
    const errors = validateContent();
    if (errors.length) {
      confirmDialog.close();
      toast(errors[0], "error", 6000);
      return;
    }
    const message = $("[data-commit-message]").value.trim() || "SWAG 콘텐츠 업데이트";
    showLoading("등록된 이미지와 게시 내용을 확인하는 중입니다.");
    try {
      const imageErrors = await validateManagedImages();
      if (imageErrors.length) {
        confirmDialog.close();
        toast(imageErrors[0], "error", 7000);
        return;
      }
      loadingText.textContent = "현재 버전과 충돌이 없는지 확인하는 중입니다.";
      const latestRef = await api(`/repos/${OWNER}/${REPO}/git/ref/heads/${BRANCH}`);
      if (latestRef.object.sha !== baseHead) {
        throw new ApiError(409, "다른 곳에서 사이트가 수정되었습니다. 새로고침 후 최신 내용을 불러와 주세요.");
      }
      content.meta.updatedAt = new Date().toISOString();
      content.projects.forEach((project, index) => { project.order = index + 1; });
      loadingText.textContent = "콘텐츠와 이미지를 하나의 버전으로 만드는 중입니다.";
      const siteBlob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
        method: "POST",
        body: JSON.stringify({ content: JSON.stringify(content, null, 2) + "\n", encoding: "utf-8" })
      });
      const uploadEntries = await Promise.all([...pendingUploads.entries()].map(async ([path, upload]) => {
        const blob = await api(`/repos/${OWNER}/${REPO}/git/blobs`, {
          method: "POST",
          body: JSON.stringify({ content: upload.base64, encoding: "base64" })
        });
        return { path, mode: "100644", type: "blob", sha: blob.sha };
      }));
      const tree = await api(`/repos/${OWNER}/${REPO}/git/trees`, {
        method: "POST",
        body: JSON.stringify({
          base_tree: baseTree,
          tree: [{ path: CONTENT_PATH, mode: "100644", type: "blob", sha: siteBlob.sha }, ...uploadEntries]
        })
      });
      const commit = await api(`/repos/${OWNER}/${REPO}/git/commits`, {
        method: "POST",
        body: JSON.stringify({ message, tree: tree.sha, parents: [baseHead] })
      });
      await api(`/repos/${OWNER}/${REPO}/git/refs/heads/${BRANCH}`, {
        method: "PATCH",
        body: JSON.stringify({ sha: commit.sha, force: false })
      });
      baseHead = commit.sha;
      baseTree = tree.sha;
      originalContent = clone(content);
      pendingUploads.clear();
      localStorage.removeItem(DRAFT_KEY);
      $("[data-draft-notice]").hidden = true;
      updateDirtyState();
      confirmDialog.close();
      toast("게시가 완료되었습니다. 사이트에는 잠시 후 자동으로 반영됩니다.", "success", 6500);
    } catch (error) {
      if (error.status === 401) {
        token = "";
        toast("관리 권한이 만료되었습니다. 관리 키를 다시 입력해 주세요.", "error", 7000);
      } else if (error.status === 403) {
        toast("사이트 수정 권한이 없습니다. 관리 키의 권한을 확인해 주세요.", "error", 7000);
      } else if (error.status === 409 || error.status === 422) {
        toast(error.message || "다른 변경과 충돌했습니다. 새로고침 후 다시 시도해 주세요.", "error", 8000);
      } else {
        toast(error.message || "게시 중 문제가 발생했습니다.", "error", 7000);
      }
    } finally {
      hideLoading();
    }
  };

  $("[data-publish-button]").addEventListener("click", () => {
    const errors = validateContent();
    if (errors.length) {
      toast(errors[0], "error", 6000);
      return;
    }
    confirmDialog.showModal();
    document.body.classList.add("has-dialog");
  });
  $("[data-confirm-cancel]").addEventListener("click", () => confirmDialog.close());
  $("[data-confirm-publish]").addEventListener("click", publish);
  confirmDialog.addEventListener("close", () => document.body.classList.remove("has-dialog"));

  $("[data-draft-restore]").addEventListener("click", () => {
    try {
      const saved = JSON.parse($("[data-draft-notice]").dataset.savedDraft);
      assertEditableContent(saved.content);
      content = saved.content;
      renderAll();
      $("[data-draft-notice]").hidden = true;
      toast("임시 저장 내용을 불러왔습니다.", "success");
    } catch {
      toast("임시 저장 내용을 불러오지 못했습니다.", "error");
    }
  });

  $("[data-draft-discard]").addEventListener("click", () => {
    localStorage.removeItem(DRAFT_KEY);
    $("[data-draft-notice]").hidden = true;
    toast("임시 저장 내용을 삭제했습니다.");
  });

  const logout = () => {
    if (dirty && !window.confirm("게시하지 않은 변경이 있습니다. 연결을 종료할까요?")) return;
    token = "";
    window.location.reload();
  };

  $("[data-logout-button]").addEventListener("click", logout);
  window.addEventListener("beforeunload", (event) => {
    if (!dirty) return;
    event.preventDefault();
    event.returnValue = "";
  });

  [previewDialog, historyDialog, confirmDialog].forEach((dialog) => {
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) dialog.close();
    });
  });

})();
