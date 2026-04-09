export type JobStatus = 'pending' | 'processing' | 'done' | 'failed'

export interface SavedReference {
  id:         string
  user_id:    string
  name:       string
  image_url:  string
  created_at: string
}

export interface Job {
  id: string
  user_id: string
  image1_url: string
  image2_url: string
  output_url: string | null
  status: JobStatus
  created_at: string
}

export interface VideoJob {
  id: string
  user_id: string
  subject_url: string
  output_url: string | null   // retouched image used for video generation
  video_url: string | null    // final rendered video
  task_id: string | null      // Kling task ID
  showcase: string
  duration: number
  status: 'processing' | 'done' | 'failed'
  created_at: string
}

export type ProgressStep =
  | 'idle'
  | 'uploading'
  | 'analyzing-style'
  | 'analyzing-subject'
  | 'generating'
  | 'done'
  | 'error'

export interface ProgressEvent {
  step: Exclude<ProgressStep, 'idle' | 'uploading' | 'done' | 'error'>
  message: string
}
