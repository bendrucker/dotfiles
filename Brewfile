# In CI, avoid installing Casks and Mac App Store apps which are slow and depended upon by dotfiles
if ENV['CI']
  def cask(*args)
    # no-op
  end

  def mas(*args)
    # noop
  end
end

corporate = Dir.exist?('/Library/Managed Preferences') && !Dir.empty?('/Library/Managed Preferences')
corporate_cask_args = corporate ? { adopt: true } : {}

cask_args appdir: '/Applications'

tap 'teamookla/speedtest'

brew 'bat'
brew 'cloc'
brew 'coreutils'
brew 'csvkit'
brew 'jq'
brew 'mas' if OS.mac?
brew 'openssl'
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
cask 'logi-options+'
cask 'monitorcontrol'
cask 'monodraw'
cask 'ollama-app'
cask 'pdfpen'
cask 'raycast'
cask 'screens-connect'
cask 'slack'
cask 'the-unarchiver'
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
