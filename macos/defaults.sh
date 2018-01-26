# hide desktop
defaults write com.apple.finder CreateDesktop -bool false

killall Finder

# tracking: 2nd fastest setting
defaults write -g com.apple.mouse.scaling 2.5