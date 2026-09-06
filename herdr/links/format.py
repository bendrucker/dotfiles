RESET = "\033[0m"

BLUE = (0, 180, 255)
ORANGE = (252, 109, 38)
GREEN = (80, 200, 120)
AMBER = (245, 180, 90)
PURPLE = (94, 106, 210)
LOCAL = (120, 200, 120)


def colorize(text: str, rgb: tuple[int, int, int]) -> str:
    r, g, b = rgb
    return f"\033[38;2;{r};{g};{b}m{text}{RESET}"
