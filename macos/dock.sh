# enable autohide
defaults write com.apple.dock autohide -bool true

# remove delay
defaults write com.apple.dock autohide-delay -float 0

# empty persistent contents
defaults write com.apple.dock persistent-apps -array
defaults write com.apple.dock persistent-others -array

# lock contents
defaults write com.apple.dock contents-immutable -bool true

killall Dock