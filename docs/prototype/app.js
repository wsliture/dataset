"use strict";

const searchForm = $("#case-search-form");
const searchQuery = $("#case-search-query");
const searchLog = $("#case-search-log");
const searchError = $("#case-search-error");

function normalizeSearch(text) {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function searchTerms(text) {
  const identifiers = text.match(/[a-z0-9]+(?:[_.:/-][a-z0-9]+)*/g) || [];
  const terms = new Set(identifiers);
  for (const run of text.match(/\p{Script=Han}+/gu) || []) {
    const characters = [...run];
    if (characters.length === 1) terms.add(run);
    for (let index = 1; index < characters.length; index++) {
      terms.add(characters[index - 1] + characters[index]);
    }
  }
  return terms;
}

function searchSliceText(slice) {
  const cells = (slice.table || slice.row || []).flat(Infinity);
  return [slice.text, ...cells].filter(Boolean).join(" ");
}

function findCases(query) {
  const phrase = normalizeSearch(query);
  const terms = searchTerms(phrase);
  const singleIdentifier = /^[a-z0-9]+(?:[_.:/-][a-z0-9]+)*$/.test(phrase);
  const results = [];
  for (const record of db.cases.filter(eligible)) {
    const matches = [];
    for (const source of snapshots(record, "input")) {
      for (const slice of source.units) {
        const text = normalizeSearch(searchSliceText(slice));
        const sliceTerms = searchTerms(text);
        const exact = terms.size > 0 && (singleIdentifier ? sliceTerms.has(phrase) : text.includes(phrase));
        const overlap = [...terms].filter((term) => sliceTerms.has(term)).length;
        if (exact || overlap) {
          matches.push({ source, slice, score: Number(exact) + overlap / (terms.size + 1) });
        }
      }
    }
    if (matches.length) {
      matches.sort((a, b) => b.score - a.score);
      results.push({
        record,
        matches,
        dataset: db.datasets.find((dataset) => dataset.id === record.dataset_id),
        score: matches[0].score,
      });
    }
  }
  return results.sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id)).slice(0, 5);
}

function searchExcerpt(source, slice) {
  const location = [source.document_name, ...slice.section_path, slice.locator].filter(Boolean).join(" · ");
  return `<small>${esc(location)}</small><p>${esc(searchSliceText(slice))}</p>`;
}

function searchResult({ record, matches, dataset }) {
  const outputs = snapshots(record, "output")
    .flatMap((source) => source.units.map((slice) => searchExcerpt(source, slice)));
  return `<article class="panel search-result" data-search-dataset="${esc(dataset.id)}">
    <div class="row spread"><h3>${esc(record.title)}</h3>${btn("查看案例", "search-detail:" + esc(record.id), "text")}</div>
    <small>${esc(dataset.name)}</small>
    <h4>命中的源片段</h4>
    ${matches.map(({ source, slice }) => searchExcerpt(source, slice)).join("")}
    <h4>关联的人工测试需求</h4>
    ${outputs.join("")}
  </article>`;
}

function removeDatasetSearchResults(datasetId) {
  for (const reply of searchLog.querySelectorAll(".search-reply")) {
    const cards = [...reply.querySelectorAll(".search-result")];
    const removed = cards.filter((card) => card.dataset.searchDataset === datasetId);
    if (!removed.length) continue;
    removed.forEach((card) => card.remove());
    const count = cards.length - removed.length;
    reply.querySelector(".search-summary").textContent = count
      ? `找到 ${count} 条案例`
      : "该次查询的案例已删除。";
  }
}

searchQuery.addEventListener("input", () => { searchError.textContent = ""; });

searchForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const query = searchQuery.value.trim();
  if (!query) {
    searchError.textContent = "请输入源需求或设计描述。";
    searchQuery.focus();
    return;
  }

  try {
    const results = findCases(query);
    const reply = results.length
      ? `<small class="search-summary">找到 ${results.length} 条案例</small>${results.map(searchResult).join("")}`
      : '<div class="notice">没有匹配的已确认案例。</div>';
    searchLog.insertAdjacentHTML("beforeend",
      `<section><p class="query-bubble">${esc(query)}</p><div class="search-reply">${reply}</div></section>`);
  } catch {
    searchError.textContent = "查询失败，请重试。";
    searchQuery.focus();
    return;
  }
  searchLog.lastElementChild.scrollIntoView({ block: "start" });
  searchForm.reset();
  searchError.textContent = "";
  searchQuery.focus({ preventScroll: true });
});

searchLog.addEventListener("click", (event) => {
  const action = event.target.closest('[data-action^="search-detail:"]')?.dataset.action;
  if (!action) return;
  const record = db.cases.find((candidate) => candidate.id === action.slice("search-detail:".length));
  if (!record || !eligible(record)) {
    toast("案例已不符合检索条件，请重新查询");
    return;
  }
  modal("案例详情", preview(record));
});
