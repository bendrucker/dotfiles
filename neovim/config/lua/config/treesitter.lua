local treesitter = require("nvim-treesitter")

local languages = {
  "bash", "diff", "dockerfile",
  "git_config", "git_rebase", "gitcommit", "go", "gomod",
  "hcl", "javascript", "json", "lua",
  "markdown", "markdown_inline",
  "python", "ruby", "rust", "ssh_config", "terraform",
  "toml", "typescript", "tsx", "yaml",
}

treesitter.install(languages)

-- Parsers are pinned to the plugin revision and break when it moves ahead of them.
vim.api.nvim_create_autocmd("PackChanged", {
  callback = function(event)
    if event.data.spec.name == "nvim-treesitter" and event.data.kind == "update" then
      treesitter.update()
    end
  end,
})

vim.api.nvim_create_autocmd("FileType", {
  callback = function(event)
    local lang = vim.treesitter.language.get_lang(event.match)
    if not (lang and vim.treesitter.language.add(lang)) then
      return
    end

    vim.treesitter.start(event.buf, lang)

    -- foldexpr is window-local, so it would land on whatever the current window
    -- holds when the filetype is set on a buffer that isn't displayed.
    if vim.api.nvim_get_current_buf() == event.buf then
      vim.wo[0][0].foldmethod = "expr"
      vim.wo[0][0].foldexpr = "v:lua.vim.treesitter.foldexpr()"
    end
  end,
})

return { languages = languages }
