# In CI, avoid installing Casks and Mac App Store apps which are slow and depended upon by dotfiles
if ENV['CI']
  def cask(*args)
    # no-op
  end

  def mas(*args)
    # noop
  end
end

cask_args appdir: '/Applications'

tap 'homebrew/bundle'
tap 'teamookla/speedtest'

brew 'bat'
brew 'cloc'
brew 'coreutils'
brew 'csvkit'
brew 'ffmpeg'
brew 'jq'
brew 'mas'
brew 'openssl'
brew 'shellcheck'
brew 'teamookla/speedtest/speedtest'
brew 'the_silver_searcher'
brew 'tree'
brew 'watch'
brew 'yq'

cask '1password'
cask '1password-cli'
cask 'adobe-creative-cloud'
cask 'android-file-transfer'
cask 'backblaze'
cask 'charles'
cask 'disk-drill'
cask 'dash'
cask 'geekbench'
cask 'google-chrome'
cask 'hazel'
cask 'hyperkey'
cask 'istat-menus'
cask 'logi-options-plus'
cask 'monodraw'
cask 'nordvpn'
cask 'pdfpen'
cask 'raycast'
cask 'screens-connect'
cask 'slack'
cask 'the-unarchiver'
cask 'transmission'
cask 'vlc'
cask 'zoom'

mas '1Password for Safari', id: 1569813296
mas 'Actions', id: 1586435171
mas 'Amphetamine', id: 937984704
mas 'Bear Notes', id: 1091189122
mas 'Parcel', id: 639968404
mas 'Fantastical', id: 975937182
mas 'Gifski', id: 1351639930
mas 'HazeOver', id: 430798174
mas 'iA Writer', id: 775737590
mas 'iFlicks', id: 408937559
mas 'Magnet', id: 441258766
mas 'Paprika', id: 1303222628
mas 'Pixelmator Pro', id: 1289583905
mas 'Speedtest', id: 1153157709
mas 'Streaks', id: 963034692
mas 'UTC Bar', id: 525372278
mas 'Xcode', id: 497799835

# Recursively load Brewfiles relative to this file
# https://github.com/Homebrew/homebrew-bundle/issues/521#issuecomment-513551124
Dir.glob(File.join(File.dirname(__FILE__), '*', '**', 'Brewfile')) do |brewfile|
  eval(IO.read(brewfile), binding)
end
