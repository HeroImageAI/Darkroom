"""
Cut out (decision 99), step 2: put a take's subject over a new background using its Alpha-Gen matte.
  DR_VIDEO (the take) + DR_VIDEO_2 (its matte, same size and length) + DR_IMAGE_1 (the background, any size)
  -> background fitted to the frame (crop to fill) and repeated for every frame
  -> ImageCompositeMasked(background, take, matte as mask) -> MP4 with the take's own sound.
Writes workflows/video_composite.json.
"""
import json

n = {}


def node(i, cls, title, **inputs):
    n[str(i)] = {'class_type': cls, 'inputs': inputs, '_meta': {'title': title}}


node(1, 'LoadVideo', 'DR_VIDEO', file='darkroom_placeholder.mp4')
node(2, 'LoadVideo', 'DR_VIDEO_2', file='darkroom_placeholder.mp4')
node(3, 'GetVideoComponents', 'Take', video=['1', 0])
node(4, 'GetVideoComponents', 'Matte', video=['2', 0])
node(5, 'GetImageSize', 'Take size', image=['3', 0])
node(6, 'ImageScale', 'Matte to take size', image=['4', 0], upscale_method='bilinear', width=['5', 0], height=['5', 1], crop='disabled')
node(7, 'ImageToMask', 'Matte as mask', image=['6', 0], channel='red')
node(8, 'LoadImage', 'DR_IMAGE_1', image='darkroom_placeholder.png')
node(9, 'ImageScale', 'Background to frame', image=['8', 0], upscale_method='lanczos', width=['5', 0], height=['5', 1], crop='center')
node(10, 'RepeatImageBatch', 'Background per frame', image=['9', 0], amount=['5', 2])
node(11, 'ImageCompositeMasked', 'Composite', destination=['10', 0], source=['3', 0], x=0, y=0, resize_source=False, mask=['7', 0])
node(12, 'CreateVideo', 'Create video', images=['11', 0], fps=['3', 2], audio=['3', 1])
node(13, 'SaveVideo', 'DR_OUTPUT', video=['12', 0], filename_prefix='darkroom/video/cutout', format='mp4', **{'format.codec': 'h264'})
node(14, 'ImageFromBatch', 'Poster frame', image=['11', 0], batch_index=0, length=1)
node(15, 'SaveImage', 'DR_POSTER', images=['14', 0], filename_prefix='darkroom/video/cutout_poster')
node(16, 'ImageFromBatch', 'Last frame', image=['11', 0], batch_index=4095, length=1)
node(17, 'SaveImage', 'DR_LAST_FRAME', images=['16', 0], filename_prefix='darkroom/video/cutout_last')
json.dump(n, open('video_composite.json', 'w'), indent=2)
print('video_composite.json', len(n), 'nodes')
