# Fail fast if a formula or cask is declared in more than one Brewfile. The topic
# Brewfiles are eval'd through these same overrides (see the glob below), so this
# spans every Brewfile. brew bundle installs in parallel, so duplicates race on
# the Homebrew lock and abort bootstrap with a cryptic error.
def assert_unique_package(type, name)
  @declared_packages ||= {}
  key = [type, name]
  if @declared_packages[key]
    raise "Duplicate #{type} '#{name}' declared in more than one Brewfile. " \
          'Declare each package in exactly one topic Brewfile.'
  end
  @declared_packages[key] = true
end

# In CI, avoid installing Casks and Mac App Store apps which are slow and depended upon by dotfiles,
# and skip service management since runners lack a user launchd/systemd session
if ENV['CI']
  def cask(*args)
    assert_unique_package('cask', args.first)
  end
  def mas(*args) end

  def brew(name, options = {})
    assert_unique_package('brew', name)
    super(name, options.except(:restart_service, :start_service))
  end
else
  def brew(name, options = {})
    assert_unique_package('brew', name)
    super
  end

  def cask(name, *args)
    assert_unique_package('cask', name)
    super
  end

  def mas(*args) end unless $stdin.tty?
end

corporate = Dir.exist?('/Library/Managed Preferences') && !Dir.empty?('/Library/Managed Preferences')
corporate_cask_args = corporate ? { adopt: true } : {}

cask_args appdir: '/Applications'

tap 'schpet/tap'
tap 'teamookla/speedtest'

brew 'cloc'
brew 'coreutils'
brew 'csvkit'
brew 'duckdb'
brew 'jq'
brew 'openssl'
brew 'schpet/tap/linear'
brew 'shellcheck'
brew 'teamookla/speedtest/speedtest'
brew 'the_silver_searcher'
brew 'tree'
brew 'watch'
brew 'yq'

cask '1password'
cask '1password-cli'
cask 'adobe-creative-cloud' unless corporate
cask 'android-file-transfer' unless corporate
cask 'backblaze' unless corporate
cask 'charles'
cask 'disk-drill'
cask 'dash'
cask 'figma'
cask 'geekbench'
cask 'ghostty'
cask 'google-chrome', args: corporate_cask_args
cask 'hazel'
cask 'jordanbaird-ice'
cask 'istat-menus'
cask 'linearmouse'
cask 'logi-options+'
cask 'monitorcontrol'
cask 'monodraw'
cask 'ollama-app'
cask 'raycast'
cask 'screens-connect'
cask 'slack'
cask 'the-unarchiver'
cask 'vibe-island'
cask 'wispr-flow'
cask 'zoom', args: corporate_cask_args

mas '1Password for Safari', id: 1569813296
mas 'Actions', id: 1586435171
mas 'Amphetamine', id: 937984704
mas 'Parcel', id: 639968404
mas 'Fantastical', id: 975937182
mas 'Gifski', id: 1351639930
mas 'HazeOver', id: 430798174
mas 'iA Writer', id: 775737590
mas 'iFlicks', id: 408937559 unless corporate
mas 'Magnet', id: 441258766
mas 'Paprika', id: 1303222628 unless corporate
mas 'Pixelmator Pro', id: 1289583905
mas 'Speedtest', id: 1153157709
mas 'Streaks', id: 963034692
mas 'UTC Bar', id: 525372278
mas 'Xcode', id: 497799835

# Weather
mas 'Paku', id: 1534130193
# mas 'CARROT Weather: Alerts & Radar', id: 961390574 # https://github.com/mas-cli/mas/issues/321

# Recursively load Brewfiles relative to this file
# https://github.com/Homebrew/homebrew-bundle/issues/521#issuecomment-513551124
Dir.glob(File.join(File.dirname(__FILE__), '*', '**', 'Brewfile')) do |brewfile|
  eval(IO.read(brewfile), binding)
end

local_brewfile = File.expand_path('~/Brewfile.local')
eval(IO.read(local_brewfile), binding) if File.exist?(local_brewfile)
