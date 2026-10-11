# Real-photograph fixtures

Stock photographs, used under the reasoning below, to test the judge against
real images rather than the synthetic gradients in the parent directory.

| File | What it is | Must be judged |
|---|---|---|
| `outdoor-hikers.jpg` | People on rocks under trees, backlit sun | genuinely outdoors |
| `through-window.jpg` | Interior window, frame and sill, trees beyond | **rejected at `glass`** |
| `indoor-desk.jpg` | Desk, chair, lamp, indoor room | **rejected at `outdoor`** |

## Why stock photographs

These are not author photographs, and the writeup says so. They are here
because they test something the synthetic fixtures cannot: whether the model
handles the texture, noise and lighting of a real camera image. One synthetic
fixture (`outdoor-sunny.png`) is correctly flagged as a screen photo, because
it genuinely is a flat computer-generated graphic — which is exactly the
limitation these files exist to cover.

`through-window.jpg` is the important one. The window photo is the central
cheat on this product: lean over, shoot the garden through the glass, never
leave the chair. Everything else is detail.

## Measured, 2026-10-11

    outdoor-hikers    outdoor=y glass=y screen=y  -> passes authenticity
    through-window    outdoor=y glass=n           -> FAIL at glass, 28.8s
    indoor-desk       outdoor=n                   -> FAIL at outdoor, 3.4s

The window result is the one that matters: the model agreed the *scene* was
outdoors, then caught that the *camera* was not.
