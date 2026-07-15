# -*- coding: utf-8 -*-
"""Replace ChatCard input+footer block with ChatComposer."""
from pathlib import Path

p = Path("apps/crish-desktop/src/components/ChatCard.tsx")
t = p.read_text(encoding="utf-8")

start = t.find('        <div\n          className="input-container"')
if start < 0:
    start = t.find('        <div\n          className="input-container"')
# try alternate
if start < 0:
    start = t.find('className="input-container"')
    if start > 0:
        # back to line start
        start = t.rfind("\n", 0, start) + 1

end_marker = "          <div className=\"right-actions\">"
end = t.find(end_marker, start)
if start < 0 or end < 0:
    print("markers not found", start, end)
    raise SystemExit(1)

# find end of footer-actions (closing after right-actions)
# We want to replace from input-container through end of footer-actions
# Keep nothing of old left, replace including right-actions content with ChatComposer+rightActions prop

# Find closing of footer-actions: after right-actions block ends with `        </div>\n      </div>`
# Locate showModelPicker section end
right_end = t.find("          </div>\n        </div>\n      </div>\n    </div>\n  );\n});", end)
if right_end < 0:
    # fallback: from right-actions to two closing divs of footer
    right_end = t.find("\n        </div>\n      </div>\n    </div>", end)
    if right_end < 0:
        print("end not found")
        raise SystemExit(1)
    # include through footer-actions close
    close_len = len("\n        </div>\n      </div>")
    old_end = right_end + close_len
else:
    # pattern includes outer chat-footer close - too much
    # use simpler: from input-container to end of footer-actions only
    # end of right-actions is before `        </div>` that closes footer-actions
    sub = t[end:]
    # first `        </div>` after right-actions content that closes footer-actions
    # Find `          </div>\n        </div>` after model picker
    idx = sub.find("          </div>\n        </div>\n      </div>")
    if idx < 0:
        print("footer close not found")
        raise SystemExit(1)
    old_end = end + idx + len("          </div>\n        </div>")

# Extract right-actions inner for model picker - from end_marker to old_end
right_block = t[end:old_end]
# strip wrapper
inner_start = right_block.find("\n") + 1
# keep from {showModelPicker through its closing
model_start = right_block.find("{showModelPicker")
if model_start < 0:
    model_start = right_block.find("showModelPicker")
# find content inside right-actions
ra_open = right_block.find(">")
# better extract between right-actions> and last </div> of right-actions
import re
m = re.search(
    r'<div className="right-actions">\s*([\s\S]*?)\s*</div>\s*$',
    right_block,
)
right_inner = m.group(1).strip() if m else "null"

replacement = '''        {!activeAgent ? (
          <ChatComposer
            chatInput={chatInput}
            setChatInput={setChatInput}
            isComposing={isComposing}
            setIsComposing={setIsComposing}
            slashMenuOpen={slashMenuOpen}
            setSlashMenuOpen={setSlashMenuOpen}
            slashSelectedIndex={slashSelectedIndex}
            setSlashSelectedIndex={setSlashSelectedIndex}
            filteredCommands={filteredCommands}
            loadSkillSlash={loadSkillSlash}
            onPasteImage={handlePasteImage}
            onSend={() => { void handleSendChat(false); }}
            onStop={handleStopGeneration}
            canSend={canSend}
            isProcessing={messages.some((m) => m.status === 'processing')}
            attachments={attachments}
            setAttachments={setAttachments}
            fileInputRef={fileInputRef}
            onFilesSelected={async (files) => {
              const next: ChatAttachment[] = [];
              for (const f of files) {
                if (isImageFile(f)) {
                  try {
                    next.push(await blobToImageAttachment(f, f.name));
                  } catch {
                    next.push({ name: f.name, mime: f.type || undefined });
                  }
                  continue;
                }
                const isText =
                  f.type.startsWith('text/') ||
                  /\\.(txt|md|json|ts|tsx|js|jsx|css|html|py|rs|go|java|c|cpp|h|yml|yaml|toml|xml|csv|log|sh|ps1)$/i.test(
                    f.name,
                  );
                if (isText && f.size < 512_000) {
                  try {
                    const text = await f.text();
                    next.push({ name: f.name, text });
                  } catch {
                    next.push({ name: f.name });
                  }
                } else {
                  next.push({ name: f.name });
                }
              }
              addAttachments(next);
            }}
            showPlusMenu={showPlusMenu}
            setShowPlusMenu={setShowPlusMenu}
            showMoreMenu={showMoreMenu}
            setShowMoreMenu={setShowMoreMenu}
            showMsgFilter={showMsgFilter}
            setShowMsgFilter={setShowMsgFilter}
            setLocalMsgFilter={setLocalMsgFilter}
            moreMenuRef={moreMenuRef}
            permissionMode={permissionMode}
            onPermissionChange={(m) => {
              setPermissionMode(m);
            }}
            onExportMarkdown={handleExportMarkdown}
            canExport={Boolean(activeSession)}
            onOpenSchedule={() => {
              setMainSurface('scheduled');
              onShowToast('已打开定时任务');
            }}
            onShowToast={onShowToast}
            onCloseSiblingMenus={() => setShowModelDropdown(false)}
            rightActions={
              showModelPicker ? (
                <div
                  ref={modelSelectorRef}
                  className="model-badge"
                  title={
                    getActiveProfile()
                      ? `${getActiveProfile()!.name} · ${engineModel || getActiveModelId() || '未选模型'}`
                      : '选择服务商与模型'
                  }
                  onClick={() => {
                    setShowModelDropdown((prev) => !prev);
                    setShowPlusMenu(false);
                  }}
                >
                  <span className="model-text">
                    {getModelDisplayName(
                      engineModel || getActiveModelId() || '选择模型',
                    )}
                  </span>
                  <Lucide.ChevronDown size={14} style={{ opacity: 0.55 }} />
                  <ModelPicker
                    open={showModelDropdown}
                    onClose={() => setShowModelDropdown(false)}
                    engineModel={engineModel}
                    busy={pickerBusy}
                    error={pickerInlineError}
                    onSelect={(profileId, modelId) => {
                      void selectProfileModel(profileId, modelId);
                    }}
                    onOpenSettings={() => {
                      setShowModelDropdown(false);
                      useLayoutStore.getState().openSettings('models');
                    }}
                    onToast={onShowToast}
                  />
                </div>
              ) : null
            }
          />
        ) : null}'''

new_t = t[:start] + replacement + t[old_end:]
p.write_text(new_t, encoding="utf-8")
print("wired ChatComposer, old bytes", old_end - start, "new", len(replacement))
