vim.lsp.config.gopls = {
  cmd = { "gopls" },
  filetypes = { "go", "gomod" },
}

vim.lsp.config.ts_ls = {
  cmd = { "typescript-language-server", "--stdio" },
  filetypes = { "javascript", "javascriptreact", "typescript", "typescriptreact" },
}

vim.lsp.config.ty = {
  cmd = { "ty" },
  filetypes = { "python" },
}

vim.lsp.config.rust_analyzer = {
  cmd = { "rust-analyzer" },
  filetypes = { "rust" },
}

vim.lsp.config.terraformls = {
  cmd = { "terraformls" },
  filetypes = { "terraform", "terraform-vars" },
}

vim.lsp.enable({ "gopls", "ts_ls", "ty", "rust_analyzer", "terraformls" })
